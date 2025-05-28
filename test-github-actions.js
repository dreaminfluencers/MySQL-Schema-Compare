#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Simulate GitHub Actions environment
process.env.GITHUB_ACTIONS = 'true';

// Load payload
const payloadData = JSON.parse(fs.readFileSync(path.join(__dirname, 'payload.json'), 'utf8'));
const payload = payloadData.inputs;

// Mock @actions/core
const mockCore = {
  inputs: {},
  outputs: {},
  summaryContent: '',
  
  getInput: function(name) {
    const value = payload[name] || '';
    console.log(`[MOCK] core.getInput('${name}') = '${value.substring(0, 50)}${value.length > 50 ? '...' : ''}'`);
    return value;
  },
  
  setOutput: function(name, value) {
    this.outputs[name] = value;
    console.log(`[MOCK] core.setOutput('${name}', '${value}')`);
  },
  
  setFailed: function(message) {
    console.error(`[MOCK] core.setFailed('${message}')`);
  },
  
  summary: {
    addRaw: function(content) {
      mockCore.summaryContent = content;
      return this;
    },
    write: function() {
      console.log('\n📄 GitHub Actions Summary Generated:');
      console.log('='.repeat(80));
      console.log(mockCore.summaryContent);
      console.log('='.repeat(80));
      return Promise.resolve();
    }
  }
};

// Replace @actions/core in require cache
const Module = require('module');
const originalRequire = Module.prototype.require;

Module.prototype.require = function(id) {
  if (id === '@actions/core') {
    return mockCore;
  }
  return originalRequire.apply(this, arguments);
};

console.log('🧪 Testing MySQL Schema Compare Action in GitHub Actions mode...\n');

console.log('📄 Using inputs from payload.json:');
console.log(JSON.stringify({
  'main-db-host': payload['main-db-host'],
  'main-db-port': payload['main-db-port'],
  'main-db-user': payload['main-db-user'],
  'main-db-name': payload['main-db-name'],
  'main-db-ssl': payload['main-db-ssl'],
  'dev-db-host': payload['dev-db-host'],
  'dev-db-port': payload['dev-db-port'],
  'dev-db-user': payload['dev-db-user'],
  'dev-db-name': payload['dev-db-name'],
  'dev-db-ssl': payload['dev-db-ssl']
}, null, 2));

console.log('\n' + '='.repeat(50) + '\n');

// Run the action
require('./index.js');
