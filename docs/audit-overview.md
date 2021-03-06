---
title: Mola Audit Overview
markdown2extras: tables, code-friendly, fenced-code-blocks
apisections:
---
<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2014, Joyent, Inc.
-->

# Overview

There are several situations that could cause the index and the store to go out
of sync, including:

1. Garbage Collection goes really wrong.
2. Operator error.
3. File system wonkiness.

We should periodically be verifying that object metadata in Moray is correct in
that the places where moray expects objects to exist, the objects actually do
exist on mako nodes and alarm/auto-recover if not.

# Running an Audit manually and checking results

Audit is run once a day.  If, for some reason, you do, the process is below.

## Running an audit job

```
ops$ kick_off_audit.js | bunyan
```

Take the jobId from the output.  Once it is done, the output should have a
length of 0.  No output is good output.

To look at the results of the latest audit job:

```
ops$ mls -l $(mjob outputs $(mget -q /poseidon/stor/manta_audit/jobs.json | \
     json -ak | tail -1))
```

# Implementation Details

## Input

1. Moray shard dumps of the manta table ('live' objects).  Currently located at:

    /poseidon/stor/manatee_backups/[shard]/[date]/manta-[date].gz

2. Mako dumps.  Currently located at:

    /poseidon/stor/mako/[manta storage id]

## Marlin job

The audit job is kicked off from the "ops" zone deployed as part of Manta.  The
cron invokes `/opt/smartdc/mola/bin/kick_off_audit.js`, which does a few things:

1. Verifies that an audit job isn't currently running
2. Finds the latest Mako dumps, does some verification
3. Finds the Moray dumps right before the earliest mako dump, does some
   verification (chronologically: moray dumps, as little time as possible, mako
   dumps).  Since objects go into moray *last* (after mako), we can be sure that
   all objects in moray are already on makos.
4. Sets up assets and directories required by audit
5. Kicks off a marlin job

All output for the Marlin job is located under:

    /poseidon/stor/mola_audit

From a high-level, the Marlin job does the following:

1. Transforms the Mako dumps into rows that represent which objects actually
   exist on the mako node.
2. Transforms the Moray dumps for the table `manta` into records for each row.
   Each manta record is rolled out into N rows that represent the places where
   Moray expects objects to be.
3. The records for each object are then sent off to a number of reducers where a
   reducer is guaranteed to have all records for a given object.
4. The records for each object are ordered such that the mako records (where the
   object exists) is first, followed by all locations that moray expects the
   object to be.  The actual locations are held in memory while each expected
   location is compared.  For all places where an object is expected to be but
   isn't, the moray record is written to stdout.

The output of the Marlin job is a set of moray records where the object doesn't
exist.  If *any* rows are output, we alarm.

## How do you prove this works?

Records for objects only exist in two places that matter: the index (moray) and
the the object store (mako).  The write order for these records are well
defined:

```
+-----------------------------+------+-------------+------------------+----------------+
| Time                        | Mako | Moray.manta | Moray.delete_log | Mako.tombstone |
+-----------------------------+------+-------------+------------------+----------------+
| 1. Mako                     | x    |             |                  |                |
| 2. Moray: manta             | x    | x           |                  |                |
| 3. Moray: link              | x    | x           |                  |                |
| 4. Moray: Link Deleted      | x    | x           | x                |                |
| 5. Moray: Last link deleted | x    |             | x                |                |
| 6. GC: Produces delete list | x    |             | x                |                |
| 6a. Moray cleans up first   | x    |             |                  |                |
| 6b. Mako cleans up first    |      |             | x                | x              |
| 7. Grace period             |      |             |                  | x              |
| 8. Purge                    |      |             |                  |                |
+-----------------------------+------+-------------+------------------+----------------+
```

What this table shows is that the writes to Moray.manta are always sandwiched by
the object existing on the mako node.  This is why it is correct to assume
something is wrong if something is in Moray.manta (the 'live' index) and not
in mako.
