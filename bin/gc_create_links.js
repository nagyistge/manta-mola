#!/usr/bin/env node
// -*- mode: js -*-
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var assert = require('assert-plus');
var bunyan = require('bunyan');
var common = require('../lib').common;
var fs = require('fs');
var getopt = require('posix-getopt');
var manta = require('manta');
var path = require('path');
var vasync = require('vasync');



///--- Global Objects

var NAME = 'moray_gc_create_links';
var LOG = bunyan.createLogger({
        level: (process.env.LOG_LEVEL || 'info'),
        name: NAME,
        stream: process.stdout
});
var MANTA_CONFIG = (process.env.MANTA_CONFIG ||
                    '/opt/smartdc/common/etc/config.json');
var MANTA_CLIENT = manta.createClientFromFileSync(MANTA_CONFIG, LOG);
var MANTA_USER = MANTA_CLIENT.user;
var MANTA_DIR = '/' + MANTA_USER + '/stor/manta_gc/all/do';
var AUDIT = {
        'audit': true,
        'cronExec': 1,
        'cronFailed': 1,
        'count': 0,
        'startTime': new Date()
};



///--- Global Constants

var MP = '/' + MANTA_USER + '/stor';



///--- Helpers

function parseOptions() {
        var option;
        var opts = {};
        var parser = new getopt.BasicParser('d:',
                                            process.argv);
        while ((option = parser.getopt()) !== undefined && !option.error) {
                switch (option.option) {
                case 'd':
                        opts.mantaDir = option.optarg;
                        break;
                default:
                        usage('Unknown option: ' + option.option);
                        break;
                }
        }

        //Set up some defaults...
        opts.mantaDir = opts.mantaDir || MANTA_DIR;

        return (opts);
}


function usage(msg) {
        if (msg) {
                console.error(msg);
        }
        var str  = 'usage: ' + path.basename(process.argv[1]);
        str += ' [-d manta_directory]';
        console.error(str);
        process.exit(1);
}


function deleteObject(objPath, cb) {
        LOG.info({ objPath: objPath }, 'deleting object');
        ++AUDIT.count;
        MANTA_CLIENT.unlink(objPath, function (err) {
                return (cb(err));
        });
}


function processLinkFile(objPath, cb) {
        LOG.info({ objPath: objPath }, 'processing object');
        var opts = {
                'path': objPath,
                'client': MANTA_CLIENT
        };
        common.getObject(opts, function (err, data) {
                if (err) {
                        cb(err);
                        return;
                }

                var lines = data.split('\n');
                var dirs = [];
                var links = [];
                for (var i = 0; i < lines.length; ++i) {
                        var line = lines[i];
                        if (line === '') {
                                continue;
                        }
                        var parts = line.split(' ');
                        if (common.startsWith(line, 'mmkdir')) {
                                dirs.push(parts[1]);
                        } else if (common.startsWith(line, 'mln')) {
                                links.push({
                                        from: parts[1],
                                        to: parts[2]
                                });
                        } else {
                                LOG.error({ objPath: objPath },
                                          'Error with object');
                                cb(new Error(objPath +
                                             ' contains a bad line: ' +
                                             line));
                                return;
                        }
                }

                //Create dirs, then link, then delete.
                vasync.forEachParallel({
                        func: MANTA_CLIENT.mkdirp.bind(MANTA_CLIENT),
                        inputs: dirs
                }, function (err2, results) {
                        if (err2) {
                                cb(err2);
                                return;
                        }

                        vasync.forEachParallel({
                                func: function link(linkObj, subcb) {
                                        LOG.info({ linkObj: linkObj },
                                                 'linking object');
                                        MANTA_CLIENT.ln(linkObj.from,
                                                        linkObj.to, subcb);
                                },
                                inputs: links
                        }, function (err3, results2) {
                                if (err3) {
                                        cb(err3);
                                        return;
                                }

                                deleteObject(objPath, cb);
                        });
                });
        });
}


/* BEGIN JSSTYLED */
// Example path to job:
// /nfitch/stor/manta_gc/all/do/2013-04-29-18-10-07-600e0d9d-b9b0-43e7-8893-a292397bcbb1-X-06925570-b0f8-11e2-8ab7-1f4a20f74bfb-links
//                              [------ date -----]-[----------- job uuid -------------]-X-[----------- random uuid ----------]-links
/* END JSSTYLED */
function findAndVerifyJob(objPath, cb) {
        //Extract the job from the name.  This relies on the gc_links script
        // to put the job in the right place, and to not change.
        var objName = path.basename(objPath);
        var dateJobId = objName.split('-X-')[0];
        var jobId = dateJobId.substring(20);
        var opts = {
                'client': MANTA_CLIENT,
                'jobId': jobId
        };
        common.getJob(opts, function (err, job) {
                if (err) {
                        cb(err);
                        return;
                }

                if (job.state === 'running' || job.inputDone === false) {
                        LOG.info({ jobId: jobId }, 'Job still running, not ' +
                                 'doing anything.');
                        cb(null);
                        return;
                }

                if (job.stats && (job.stats.errors > 0 ||
                                  job.cancelled === true)) {
                        LOG.error({ jobId: jobId, objectPath: objPath },
                                  'Job had errors, not processing links.');
                        //My first thought was to clean up all the data
                        // associated with the job, but we need to do that for
                        // all other jobs anyways.  So rather we just delete
                        // the link file.
                        deleteObject(objPath, cb);
                        return;
                }

                processLinkFile(objPath, cb);
                return;
        });
}


function createGcLinks(opts, cb) {
        var gopts = {
                'client': MANTA_CLIENT,
                'dir': opts.mantaDir
        };
        common.getObjectsInDir(gopts, function (err, objs) {
                if (err && err.code === 'ResourceNotFound') {
                        LOG.info('GC not ready yet: ' + opts.mantaDir +
                                 ' doesn\'t exist');
                        cb();
                        return;
                } else if (err) {
                        cb(err);
                        return;
                }

                if (objs.length === 0) {
                        LOG.info('No objects found in ' + opts.mantaDir);
                        cb();
                        return;
                }

                vasync.forEachParallel({
                        func: findAndVerifyJob,
                        inputs: objs
                }, function (err2, results) {
                        cb(err2);
                        return;
                });
        });
}



///--- Main

var _opts = parseOptions();

createGcLinks(_opts, function (err) {
        if (err) {
                LOG.fatal(err, 'Error.');
        } else {
                AUDIT.cronFailed = 0;
        }

        //Write out audit record.
        AUDIT.endTime = new Date();
        AUDIT.cronRunMillis = (AUDIT.endTime.getTime() -
                               AUDIT.startTime.getTime());
        AUDIT.opts = _opts;
        LOG.info(AUDIT, 'audit');
        process.exit(AUDIT.cronFailed);
});
