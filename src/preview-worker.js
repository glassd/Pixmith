import { parentPort, workerData } from "node:worker_threads";

import { encodePreview } from "./preview.js";

// Runs encodePreview off the main thread (see makeInlineImage in preview.js).
const { png, budgetBytes } = workerData;
parentPort.postMessage(encodePreview(Buffer.from(png.buffer, png.byteOffset, png.byteLength), budgetBytes));
