'use strict';
// Programmatic API — what a repo's own test runner imports to enforce the
// contract with knowledge only it has (e.g. a component roster from JSX).
module.exports = {
  tokens: require('./core/tokens'),
  check: require('./core/check'),
  snapshot: require('./core/snapshot'),
  color: require('./core/color'),
  loadConfig: require('./core/config').loadConfig,
  setup: require('./core/setup'),
};
