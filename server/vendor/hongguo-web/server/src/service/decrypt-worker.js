'use strict';
const { parentPort, workerData } = require('worker_threads');
require('./stream').offlineDecrypt(workerData.spade, workerData.file, workerData.file)
  .then(result => parentPort.postMessage({ path: result.path }))
  .catch(error => parentPort.postMessage({ error: error.message }));
