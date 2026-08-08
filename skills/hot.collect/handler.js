'use strict';

const { fetchDouyinHotList } = require('../../src/douyin-hot');

module.exports = async function hotCollect() {
  const topics = await fetchDouyinHotList();
  return { status: 'collected', topics, artifacts: [] };
};
