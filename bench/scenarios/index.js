/**
 * Scenario registry. Import all scenarios and export as a map.
 */

import passthrough from './passthrough.js';
import transformCpu from './transform-cpu.js';
import compression from './compression.js';
import chunkAccumulation from './chunk-accumulation.js';
import backpressure from './backpressure.js';
import fetchBridge from './fetch-bridge.js';
import byteStream from './byte-stream.js';
import multiTransform from './multi-transform.js';
import responseBody from './response-body.js';

const scenarios = [
  passthrough,
  transformCpu,
  compression,
  chunkAccumulation,
  backpressure,
  fetchBridge,
  byteStream,
  multiTransform,
  responseBody,
];

export const scenarioMap = new Map(scenarios.map((s) => [s.name, s]));
export const scenarioNames = scenarios.map((s) => s.name);
export default scenarios;
