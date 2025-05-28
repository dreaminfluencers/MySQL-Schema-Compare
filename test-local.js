#!/usr/bin/env node

// Test script to run the action locally with mock inputs
const fs = require('fs');
const path = require('path');

// Read the payload.json to get our test inputs
const payload = JSON.parse(fs.readFileSync('payload.json', 'utf8'));

// Mock the @actions/core module for testing
const originalCore = require('@actions/core');
const mockInputs = payload.inputs;

// Override core.getInput to return our test values
const mockCore = {
  ...originalCore,
  getInput: (name) => {
    const value = mockInputs[name];
    console.log(`[MOCK] core.getInput('${name}') = '${value}'`);
    return value || '';
  }
};

// Replace the core module in the require cache
require.cache[require.resolve('@actions/core')] = {
  exports: mockCore
};

console.log('🧪 Running MySQL Schema Compare Action locally...\n');
console.log('📄 Using inputs from payload.json:');
console.log(JSON.stringify(mockInputs, null, 2));
console.log('\n' + '='.repeat(50) + '\n');

// Now require and run the main script
require('./index.js');
