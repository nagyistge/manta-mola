/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var assert = require('assert-plus');
var fs = require('fs');
var vasync = require('vasync');


// --- Globals
var MAX_HOURS_IN_PAST = 24;
// If the mako dumps are more than 3 days in the past we should fatal.
var MAX_MILLIS_MAKO_DUMPS_IN_PAST = 1000 * 60 * 60 * 24 * 3; // 3 days


// --- Functions

function startsWith(str, prefix) {
        return (str.slice(0, prefix.length) === prefix);
}


function startsWithOneOf(str, prefixes) {
        var sw = false;
        prefixes.forEach(function (prefix) {
                sw = sw || startsWith(str, prefix);
        });
        return (sw);
}


function endsWith(str, suffix) {
        return (str.indexOf(suffix, str.length - suffix.length) !== -1);
}


function pad(n) {
        return ((n < 10) ? '0' + n : '' + n);
}


// Manta Helpers

function getObject(opts, cb) {
        var path = opts.path;
        var client = opts.client;
        if ((typeof (opts)) === 'string') {
                path = opts;
                client = this.mantaClient;
        }
        var res = '';
        client.get(path, {}, function (err, stream) {
                if (err) {
                        cb(err);
                        return;
                }

                stream.on('error', function (err1) {
                        cb(err1);
                        return;
                });

                stream.on('data', function (data) {
                        res += data;
                });

                stream.on('end', function () {
                        cb(null, res);
                        return;
                });
        });
}


function getObjectsInDir(opts, cb) {
        var dir = opts.dir;
        var client = opts.client;
        if ((typeof (opts)) === 'string') {
                dir = opts;
                client = this.mantaClient;
        }

        assert.string(dir, 'dir');
        assert.object(client, 'client');

        var objects = [];
        client.ls(dir, {}, function (err, res) {
                if (err) {
                        cb(err);
                        return;
                }

                res.on('object', function (obj) {
                        if (opts.returnObjects) {
                                objects.push({
                                        'directory': dir,
                                        'object': obj,
                                        'fullPath': dir + '/' + obj.name
                                });
                        } else {
                                objects.push(dir + '/' + obj.name);
                        }
                });

                res.once('error', function (err2) {
                        cb(err2);
                });

                res.once('end', function () {
                        cb(null, objects);
                });
        });
}


function getObjectToFile(opts, cb) {
        assert.object(opts, 'opts');
        assert.object(opts.client, 'opts.client');
        assert.string(opts.file, 'opts.file');
        assert.string(opts.path, 'opts.path');

        var out = fs.createWriteStream(opts.file);
        out.on('open', function () {
                opts.client.get(opts.path, function (err, stream, res) {
                        if (err) {
                                return (cb(err));
                        }

                        stream.pipe(out);
                        stream.on('end', cb);
                });
        });
}


function getJob(opts, cb) {
        assert.object(opts, 'opts');
        assert.object(opts.client, 'opts.client');
        assert.string(opts.jobId, 'opts.jobId');
        assert.func(cb, 'callback');

        var client = opts.client;
        var jobId = opts.jobId;

        client.job(jobId, function (err, job) {
                if (err && err.name === 'ResourceNotFoundError') {
                        //Attempt to fetch the job at the archived location
                        opts.path = '/' + client.user + '/jobs/' + jobId +
                                '/job.json';
                        getObject(opts, function (err2, res) {
                                if (err2) {
                                        cb(err); //return original error.
                                        return;
                                }
                                var jObj = JSON.parse(res);
                                cb(null, jObj);
                        });
                } else {
                        cb(err, job);
                }
        });
}


function findShardObjects(opts, cb) {
        assert.string(opts.shard, 'opts.shard');
        assert.object(opts.client, 'opts.client');

        // If your table prefixes collide, then you'll get false results.
        // For manatee dumps, just make sure it ends with a '-'.  For
        // example: ['manta-', 'manta_delete_log-']
        assert.arrayOfString(opts.tablePrefixes, 'opts.tablePrefixes');

        // These are added for recursion... though you can send in a
        // timestamp if you want to start searching from sometime other
        // than 'now'
        assert.optionalNumber(opts.maxHoursInPast, 'opts.maxHoursInPast');
        assert.optionalNumber(opts.iteration, 'opts.iteration');
        assert.optionalNumber(opts.timestamp, 'opts.timestamp');

        if (opts.maxHoursInPast === null || opts.maxHoursInPast == undefined) {
                opts.maxHoursInPast = MAX_HOURS_IN_PAST;
        }
        if (opts.iteration === null || opts.iteration == undefined) {
                opts.iteration = 0;
        }
        if (opts.timestamp === null || opts.timestamp == undefined) {
                opts.timestamp = new Date().getTime();
        }

        // Kick out here
        if (opts.iteration >= opts.maxHoursInPast) {
                return (cb(new Error('Couldnt find objects for ' +
                                     opts.shard + ' in past ' +
                                     opts.iteration + ' hours before ' +
                                     new Date(opts.timestamp))));
        }

        // # of iteration hours before
        var d = new Date(opts.timestamp - (opts.iteration * 60 * 60 * 1000));

        // Construct a path like:
        // /poseidon/stor/manatee_backups/1.moray.coal.joyent.us/2014/05/04/20
        var dir = '/' + opts.client.user + '/stor/manatee_backups/' +
                opts.shard + '/' +
                d.getFullYear() + '/' +
                pad(d.getMonth() + 1) + '/' +
                pad(d.getDate()) + '/' +
                pad(d.getHours());

        opts.client.ls(dir, {}, function (err, res) {
                function next() {
                        opts.iteration += 1;
                        findShardObjects(opts, cb);
                }
                if (err && err.code !== 'NotFoundError') {
                        return (cb(err));
                }
                if (err) {
                        return (next());
                }

                var objs = [];

                res.on('object', function (o) {
                        objs.push(o);
                });

                res.on('error', function (err2) {
                        cb(err2);
                });

                res.on('end', function () {
                        var filtered = [];
                        objs.forEach(function (o) {
                                o.directory = dir;
                                o.path = o.directory + '/' + o.name;
                                var n = o.name;
                                if (startsWithOneOf(n, opts.tablePrefixes)) {
                                        filtered.push(o);
                                }
                        });
                        if (filtered.length === opts.tablePrefixes.length) {
                                return (cb(null, filtered));
                        }
                        next();
                });
        });
}


function findObjectsForShards(opts, cb) {
        assert.object(opts, 'opts');
        assert.arrayOfString(opts.shards, 'opts.shards');
        assert.object(opts.client, 'opts.client');
        assert.object(opts.log, 'opts.log');
        assert.arrayOfString(opts.tablePrefixes, 'opts.tablePrefixes');
        assert.optionalNumber(opts.timestamp, 'opts.timestamp');
        assert.optionalBool(opts.returnObjects, 'opts.returnObjects');

        var shards = opts.shards;
        if (shards.length === 0) {
                cb(new Error('No shards specified.'));
                return;
        }

        vasync.forEachParallel({
                func: findShardObjects,
                inputs: shards.map(function (s) {
                        return ({
                                'shard': s,
                                'client': opts.client,
                                'tablePrefixes': opts.tablePrefixes,
                                'timestamp': opts.timestamp
                        });
                })
        }, function (err, results) {
                if (err) {
                        return (cb(err));
                }
                if (results.successes.length !== shards.length) {
                        return (cb(new Error('Couldnt find latest backups ' +
                                             'for all shards.')));
                }

                var objects = [];
                var earliestMorayDump = null;
                for (var i = 0; i < shards.length; ++i) {
                        var res = results.successes[i];
                        res.forEach(function (o) {
                                var mtime = new Date(o.mtime);
                                if (!earliestMorayDump ||
                                    mtime < earliestMorayDump) {
                                        earliestMorayDump = mtime;
                                }
                                if (opts.returnObjects) {
                                        objects.push(o);
                                } else {
                                        objects.push(o.path);
                                }
                        });
                        opts.earliestMorayDump = earliestMorayDump;
                }

                opts.log.info(objects, 'found objects for shard');
                cb(null, objects);
        });
}


function findLatestMakoObjects(opts, cb) {
        assert.object(opts, 'opts');
        assert.object(opts.client, 'opts.client');
        assert.object(opts.log, 'opts.log');

        var client = opts.client;

        var gopts = {
                'dir': '/' + client.user + '/stor/mako',
                'client': client,
                'returnObjects': true
        };
        getObjectsInDir(gopts, function (err, objects) {
                if (err && (err.name === 'ResourceNotFoundError' ||
                            err.code === 'NotFoundError')) {
                        opts.log.info('No Mako Objects found');
                        return (cb(null, []));
                }
                if (err) {
                        return (cb(err));
                }

                var earliestDump = null;
                for (var i = 0; i < objects.length; ++i) {
                        var o = objects[i].object;
                        //We can string compare here since we have an
                        // ISO 8601 date.
                        if (earliestDump === null || earliestDump > o.mtime) {
                                earliestDump = o.mtime;
                        }
                }
                if (earliestDump === null) {
                        return (cb(new Error('Couldn\'t determine earliest ' +
                                             'dump from mako dumps.')));
                }

                // Mako dumps are too far in the past, then fatal.
                var now = new Date().getTime();
                var eTime = new Date(earliestDump).getTime();
                if ((now - MAX_MILLIS_MAKO_DUMPS_IN_PAST) > eTime) {
                        var error = new Error('Earliest mako dumps are too ' +
                                              ' old: ' + earliestDump);
                        return (cb(error));
                }

                opts.earliestMakoDump = earliestDump;
                var paths = objects.map(function (ob) {
                        return (ob.fullPath);
                });

                opts.log.info(paths, 'found latest mako objects');
                return (cb(null, paths));
        });
}


//Finds a set of dumps where:
// 1) The mako dumps are the latest ones
// 2) The moray dumps are as close to the latest mako dumps as possible,
//    but still before.
//
// Returns and object with the following fields:
//   objects             Array of Strings
//   earliestMakoDump    ISO 8601 date
//   earliestMorayDump   ISO 8601 date
function findMorayMakoObjects(opts, cb) {
        assert.object(opts, 'opts');
        assert.object(opts.client, 'opts.client');
        assert.object(opts.log, 'opts.log');
        assert.arrayOfString(opts.shards, 'opts.shards');
        assert.arrayOfString(opts.tablePrefixes, 'opts.tablePrefixes');

        var log = opts.log;
        var popts = {
                'client': opts.client,
                'log': opts.log,
                'shards': opts.shards,
                'tablePrefixes': opts.tablePrefixes
        };
        var objects = [];
        function mako(_, subcb) {
                log.info('finding mako objects');
                findLatestMakoObjects(_, function (e, r) {
                        if (e) {
                                return (subcb(e));
                        }
                        if (r.length < 1) {
                                return (subcb(e));
                        }
                        //Set the earliest mako dump to the timestamp so that
                        // findShardObjects will search before that.
                        _.timestamp = new Date(_.earliestMakoDump).getTime();
                        objects = objects.concat(r);
                        return (subcb());
                });
        }

        function moray(_, subcb) {
                log.info('finding moray objects');
                findObjectsForShards(_, function (e, r) {
                        if (e) {
                                return (subcb(e));
                        }
                        if (r.length < 1) {
                                return (subcb(e));
                        }
                        objects = objects.concat(r);
                        return (subcb());
                });
        }

        vasync.pipeline({
                funcs: [
                        mako,
                        moray
                ],
                arg: popts
        }, function (err) {
                if (err) {
                        return (cb(err, []));
                }
                cb(null, {
                        'objects': objects,
                        'earliestMakoDump': popts.earliestMakoDump,
                        'earliestMorayDump': popts.earliestMorayDump
                });
        });
}


module.exports = {
        endsWith: endsWith,
        findLatestMakoObjects: findLatestMakoObjects,
        findMorayMakoObjects: findMorayMakoObjects,
        findObjectsForShards: findObjectsForShards,
        findShardObjects: findShardObjects,
        getJob: getJob,
        getObject: getObject,
        getObjectsInDir: getObjectsInDir,
        getObjectToFile: getObjectToFile,
        startsWith: startsWith
};
