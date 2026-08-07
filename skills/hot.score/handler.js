'use strict';

const { scorePromptLibraryTopic } = require('../../src/douyin-hot');

module.exports = async function hotScore(input = {}) {
  return { status: 'scored', score: scorePromptLibraryTopic(input), artifacts: [] };
};
