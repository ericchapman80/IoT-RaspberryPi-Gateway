/* Lightweight fixture coverage for every bundled node module.
 * This intentionally does not start gateway.js or touch a database/radio.
 */
const assert = require('assert');
const path = require('path');

const fixtures = {
  'doorbellmote.js': ['RING', 'BELL:1'],
  'garagemote.js': ['OPEN', 'CLOSED'],
  'motionmote.js': ['MOTION', 'LO:12s'],
  'RadioThermostat_CT50.js': ['MODE:HEAT', 'TARGET:68'],
  'sonarmote.js': ['42cm'],
  'sprinklers.js': ['ZONE:3', 'ZONES:OFF'],
  'switchmote.js': ['BTN0:1', 'BTN1:0'],
  'watermeter.js': ['GPM:1.2', 'GAL:42'],
  'weathershield.js': ['F:72.4', 'H:48', 'P:29.9'],
};

for (const [filename, samples] of Object.entries(fixtures)) {
  const modulePath = path.join(__dirname, '..', 'metrics', '_LowPowerLab', filename);
  const definition = require(modulePath);
  assert(definition.metrics && Object.keys(definition.metrics).length > 0, `${filename}: metrics missing`);
  for (const sample of samples) {
    assert(
      Object.values(definition.metrics).some(metric => metric.regexp.test(sample)),
      `${filename}: no metric matched ${sample}`
    );
  }
}

console.log(`metric fixture coverage passed for ${Object.keys(fixtures).length} node modules`);
