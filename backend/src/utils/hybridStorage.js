'use strict';

const fs = require('fs');
const path = require('path');
const storageService = require('../services/storageService');

// Drop-in multer storage engine. Writes to local disk when R2 isn't
// configured — today's only real state, and byte-identical to the plain
// multer.diskStorage each upload route used before — or uploads to R2 when
// it is. `subdir` prefixes the R2 object key (mirrors the on-disk directory
// layout) so a stored filename means the same thing under either backend.
function hybridStorage(destDir, subdir, filenameFn) {
  return {
    _handleFile(req, file, cb) {
      const filename = filenameFn(req, file);

      if (!storageService.isConfigured()) {
        const dest = path.join(destDir, filename);
        const outStream = fs.createWriteStream(dest);
        file.stream.pipe(outStream);
        outStream.on('error', cb);
        outStream.on('finish', () => cb(null, { filename, path: dest, size: outStream.bytesWritten, storageBackend: 'disk' }));
        return;
      }

      const chunks = [];
      let size = 0;
      file.stream.on('data', (chunk) => { chunks.push(chunk); size += chunk.length; });
      file.stream.on('error', cb);
      file.stream.on('end', () => {
        storageService.putObject(`${subdir}/${filename}`, Buffer.concat(chunks), file.mimetype)
          .then(() => cb(null, { filename, size, storageBackend: 'r2' }))
          .catch(cb);
      });
    },
    _removeFile(req, file, cb) {
      if (file.storageBackend === 'r2') {
        storageService.deleteObject(`${subdir}/${file.filename}`).then(() => cb(null)).catch(cb);
      } else if (file.path) {
        fs.unlink(file.path, cb);
      } else {
        cb(null);
      }
    },
  };
}

module.exports = { hybridStorage };
