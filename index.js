const mysql = require('mysql2/promise');
const chalk = require('chalk');
const core = require('@actions/core');

class SchemaChecker {
  constructor() {
    this.mainDb = null;
    this.devDb = null;
    this.capturedOutput = [];
  }

  // Capture console output for GitHub Actions summary
  captureOutput(message) {
    this.outputLines.push(message);
    console.log(message);
  }

  // Override console.log temporarily to capture all output
  setupOutputCapture() {
    this.capturedOutput = [];
    
    // Store original console methods
    this.originalConsole = {
      log: console.log,
      error: console.error,
      warn: console.warn,
      info: console.info
    };
    
    // Override console methods to capture all output
    const captureOutput = (type, originalMethod) => {
      return (...args) => {
        // Convert arguments to strings, handling chalk colors
        const message = args.map(arg => {
          if (typeof arg === 'string') {
            // Strip ANSI color codes for clean summary output
            return arg.replace(/\x1b\[[0-9;]*m/g, '');
          }
          return JSON.stringify(arg);
        }).join(' ');
        
        this.capturedOutput.push({ type, message, timestamp: new Date().toISOString() });
        originalMethod.apply(console, args);
      };
    };
    
    console.log = captureOutput('log', this.originalConsole.log);
    console.error = captureOutput('error', this.originalConsole.error);
    console.warn = captureOutput('warn', this.originalConsole.warn);
    console.info = captureOutput('info', this.originalConsole.info);
  }

  restoreConsoleLog() {
    // Restore all original console methods
    console.log = this.originalConsole.log;
    console.error = this.originalConsole.error;
    console.warn = this.originalConsole.warn;
    console.info = this.originalConsole.info;
  }

  // Generate GitHub Actions step summary with full console output
  generateActionsSummary(result) {
    const summary = [];
    
    summary.push('# 🔍 MySQL Schema Comparison Report');
    summary.push('');
    
    // Status
    if (result.isInSync) {
      summary.push('## ✅ Status: In Sync');
      summary.push('Main database has everything from dev database.');
    } else {
      summary.push('## ❌ Status: Out of Sync');
      summary.push('Main database is missing elements from dev database.');
    }
    
    summary.push('');
    
    // Summary statistics
    summary.push('## 📊 Summary');
    summary.push('| Category | Count |');
    summary.push('|----------|-------|');
    summary.push(`| Missing Tables | ${result.missingTables?.length || 0} |`);
    summary.push(`| Missing Columns | ${result.missingColumns?.length || 0} |`);
    summary.push(`| Different Columns | ${result.differentColumns?.length || 0} |`);
    summary.push(`| Missing Indexes | ${result.missingIndexes?.length || 0} |`);
    summary.push('');
    
    // Full console output
    summary.push('## 📋 Full Console Output');
    summary.push('');
    summary.push('<details>');
    summary.push('<summary>Click to view complete log</summary>');
    summary.push('');
    summary.push('```');
    
    if (this.capturedOutput && this.capturedOutput.length > 0) {
      this.capturedOutput.forEach(output => {
        const timestamp = new Date(output.timestamp).toLocaleTimeString();
        summary.push(`[${timestamp}] ${output.message}`);
      });
    } else {
      summary.push('No output captured');
    }
    
    summary.push('```');
    summary.push('</details>');
    summary.push('');
    
    // Detailed differences (if any)
    if (!result.isInSync) {
      if (result.missingTables?.length > 0) {
        summary.push('## 📋 Missing Tables');
        result.missingTables.forEach(table => {
          summary.push(`- ${table}`);
        });
        summary.push('');
      }
      
      if (result.missingColumns?.length > 0) {
        summary.push('## 📋 Missing Columns');
        result.missingColumns.forEach(col => {
          summary.push(`- ${col.table}.${col.column}`);
        });
        summary.push('');
      }
      
      if (result.differentColumns?.length > 0) {
        summary.push('## 📋 Different Columns');
        result.differentColumns.forEach(col => {
          summary.push(`- ${col.table}.${col.column}: ${col.difference}`);
        });
        summary.push('');
      }
    }
    
    summary.push('---');
    summary.push(`Generated at: ${new Date().toISOString()}`);
    
    return summary.join('\n');
  }

  // Generate detailed PR comment with SQL commands
  async generatePRComment(result) {
    const comment = [];
    
    comment.push('## 🚨 Database Schema Differences Detected');
    comment.push('');
    comment.push('The schema comparison between your development and production databases found differences:');
    comment.push('');
    
    // Summary table
    comment.push('| Category | Count |');
    comment.push('|----------|-------|');
    comment.push(`| Missing Tables | ${result.missingTables?.length || 0} |`);
    comment.push(`| Missing Columns | ${result.missingColumns?.length || 0} |`);
    comment.push(`| Different Columns | ${result.differentColumns?.length || 0} |`);
    comment.push(`| Missing Indexes | ${result.missingIndexes?.length || 0} |`);
    comment.push('');
    
    // Detailed differences
    if (result.missingTables?.length > 0 || result.missingColumns?.length > 0 || result.differentColumns?.length > 0 || result.missingIndexes?.length > 0) {
      comment.push('## 🔍 Detailed Differences');
      comment.push('');
      
      // Group differences by table
      const tableGroups = {};
      
      // Add missing tables
      if (result.missingTables?.length > 0) {
        result.missingTables.forEach(table => {
          if (!tableGroups[table]) tableGroups[table] = { missing: true, columns: [], indexes: [] };
        });
      }
      
      // Add missing columns
      if (result.missingColumns?.length > 0) {
        result.missingColumns.forEach(({ table, column }) => {
          if (!tableGroups[table]) tableGroups[table] = { columns: [], indexes: [] };
          tableGroups[table].columns.push({ type: 'missing', column });
        });
      }
      
      // Add different columns
      if (result.differentColumns?.length > 0) {
        result.differentColumns.forEach(({ table, column, differences }) => {
          if (!tableGroups[table]) tableGroups[table] = { columns: [], indexes: [] };
          tableGroups[table].columns.push({ type: 'different', column, differences });
        });
      }
      
      // Add missing indexes
      if (result.missingIndexes?.length > 0) {
        result.missingIndexes.forEach(index => {
          if (!tableGroups[index.table]) tableGroups[index.table] = { columns: [], indexes: [] };
          tableGroups[index.table].indexes.push(index);
        });
      }
      
      // Display grouped differences
      Object.keys(tableGroups).forEach(tableName => {
        const group = tableGroups[tableName];
        
        if (group.missing) {
          comment.push(`### ❌ Table: \`${tableName}\``);
          comment.push('**Missing entire table in main database**');
          comment.push('');
        } else {
          comment.push(`### ⚠️ Table: \`${tableName}\``);
          
          // Show column differences
          if (group.columns.length > 0) {
            comment.push('**Column differences:**');
            group.columns.forEach(({ type, column, differences }) => {
              if (type === 'missing') {
                comment.push(`- ❌ Missing column: \`${column.name}\` (\`${column.type}\`)`);
              } else if (type === 'different') {
                comment.push(`- ⚠️ Different column: \`${column.name}\` - ${differences.join(', ')}`);
              }
            });
            comment.push('');
          }
          
          // Show index differences
          if (group.indexes.length > 0) {
            comment.push('**Index differences:**');
            group.indexes.forEach(index => {
              const columns = index.columns.join(', ');
              const unique = index.unique ? 'UNIQUE ' : '';
              comment.push(`- ❌ Missing ${unique}index: \`${index.name}\` on columns (\`${columns}\`)`);
            });
            comment.push('');
          }
        }
      });
      
      // SQL Commands section
      comment.push('## 📋 SQL Commands to Fix');
      comment.push('');
      comment.push('<details>');
      comment.push('<summary>Click to view SQL commands</summary>');
      comment.push('');
      comment.push('```sql');
      
      // Missing tables
      if (result.missingTables?.length > 0) {
        comment.push('-- Missing Tables --');
        for (const table of result.missingTables) {
          const createStatement = await this.getCreateTableStatement(this.devDb, table);
          comment.push(createStatement + ';');
          comment.push('');
        }
      }
      
      // Missing columns
      if (result.missingColumns?.length > 0) {
        comment.push('-- Missing Columns --');
        for (const { table, column } of result.missingColumns) {
          const alterStatement = this.generateAlterColumnCommand(table, column);
          comment.push(alterStatement);
        }
        comment.push('');
      }
      
      // Different columns
      if (result.differentColumns?.length > 0) {
        comment.push('-- Modified Columns (review carefully before running) --');
        for (const { table, column, differences } of result.differentColumns) {
          comment.push(`-- Column ${column.name} in table ${table}: ${differences.join(', ')}`);
          const modifyStatement = this.generateModifyColumnCommand(table, column);
          comment.push(modifyStatement);
        }
        comment.push('');
      }
      
      // Missing indexes
      if (result.missingIndexes?.length > 0) {
        comment.push('-- Missing Indexes --');
        for (const index of result.missingIndexes) {
          const createStatement = this.generateCreateIndexCommand(index);
          comment.push(createStatement);
        }
      }
      
      comment.push('```');
      comment.push('</details>');
      comment.push('');
    }
    
    // Next steps
    comment.push('### 📋 Next Steps:');
    comment.push(`1. Review the detailed comparison in the [Actions summary](${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID})`);
    comment.push('2. Apply the generated SQL commands to your production database');
    comment.push('3. Re-run this check to verify the changes');
    comment.push('');
    
    // Important notes
    comment.push('### ⚠️ Important:');
    comment.push('- Review all SQL commands before executing them');
    comment.push('- Consider creating a backup before applying changes');
    comment.push('- Test changes in a staging environment first');
    comment.push('');
    
    comment.push('---');
    comment.push('🤖 *This comment was automatically generated by the MySQL Schema Compare action*');
    
    return comment.join('\n');
  }

  async connect() {
    console.log(chalk.blue('🚀 Connecting to databases (read-only)...\n'));
    
    const mainConfig = {
      host: core.getInput('main-db-host'),
      port: core.getInput('main-db-port'),
      user: core.getInput('main-db-user'),
      password: core.getInput('main-db-password'),
      database: core.getInput('main-db-name')
    };

    if (core.getInput('main-db-ssl') === 'true') {
      const mainSslCa = core.getInput('main-db-ssl-ca');
      if (mainSslCa) {
        mainConfig.ssl = { ca: mainSslCa };
      } else {
        mainConfig.ssl = {};
      }
    }

    this.mainDb = await mysql.createConnection(mainConfig);

    const devConfig = {
      host: core.getInput('dev-db-host'),
      port: core.getInput('dev-db-port'),
      user: core.getInput('dev-db-user'),
      password: core.getInput('dev-db-password'),
      database: core.getInput('dev-db-name')
    };

    if (core.getInput('dev-db-ssl') === 'true') {
      const devSslCa = core.getInput('dev-db-ssl-ca');
      if (devSslCa) {
        devConfig.ssl = { ca: devSslCa };
      } else {
        devConfig.ssl = {};
      }
    }

    this.devDb = await mysql.createConnection(devConfig);

    console.log(chalk.green('✅ Connected to both databases\n'));
  }

  async disconnect() {
    if (this.mainDb) await this.mainDb.end();
    if (this.devDb) await this.devDb.end();
  }

  async getTables(connection) {
    // Get only actual tables, not views
    const [rows] = await connection.execute(`
      SELECT TABLE_NAME 
      FROM INFORMATION_SCHEMA.TABLES 
      WHERE TABLE_SCHEMA = DATABASE() 
      AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME
    `);
    return rows.map(row => row.TABLE_NAME);
  }

  async getCreateTableStatement(connection, tableName) {
    const [rows] = await connection.execute(`SHOW CREATE TABLE \`${tableName}\``);
    return rows[0]['Create Table'];
  }

  async getTableColumns(connection, tableName) {
    const [rows] = await connection.execute(`
      SELECT 
        COLUMN_NAME as name,
        COLUMN_TYPE as type,
        IS_NULLABLE as nullable,
        COLUMN_DEFAULT as defaultValue,
        EXTRA as extra,
        COLUMN_KEY as keyType,
        CHARACTER_MAXIMUM_LENGTH as maxLength,
        NUMERIC_PRECISION as numericPrecision,
        NUMERIC_SCALE as numericScale
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION
    `, [tableName]);
    
    return rows;
  }

  async getTableIndexes(connection, tableName) {
    const [rows] = await connection.execute(`SHOW INDEX FROM \`${tableName}\``);
    
    const indexes = {};
    rows.forEach(row => {
      if (row.Key_name !== 'PRIMARY') {
        if (!indexes[row.Key_name]) {
          indexes[row.Key_name] = {
            name: row.Key_name,
            columns: [],
            unique: row.Non_unique === 0,
            table: tableName
          };
        }
        indexes[row.Key_name].columns.push(row.Column_name);
      }
    });

    return Object.values(indexes);
  }

  compareColumns(devColumn, mainColumn) {
    const differences = [];

    if (devColumn.type !== mainColumn.type) {
      differences.push(`type: '${mainColumn.type}' → '${devColumn.type}'`);
    }

    if (devColumn.nullable !== mainColumn.nullable) {
      differences.push(`nullable: ${mainColumn.nullable} → ${devColumn.nullable}`);
    }

    // Handle NULL default values properly
    const devDefault = devColumn.defaultValue === null ? 'NULL' : devColumn.defaultValue;
    const mainDefault = mainColumn.defaultValue === null ? 'NULL' : mainColumn.defaultValue;
    
    if (devDefault !== mainDefault) {
      differences.push(`default: ${mainDefault} → ${devDefault}`);
    }

    if (devColumn.extra !== mainColumn.extra) {
      differences.push(`extra: '${mainColumn.extra}' → '${devColumn.extra}'`);
    }

    return differences;
  }

  generateAlterColumnCommand(tableName, column) {
    let sql = `ALTER TABLE \`${tableName}\` ADD COLUMN \`${column.name}\` ${column.type}`;
    
    if (column.nullable === 'NO') {
      sql += ' NOT NULL';
    }
    
    if (column.defaultValue !== null) {
      sql += ` DEFAULT ${column.defaultValue}`;
    }
    
    if (column.extra) {
      sql += ` ${column.extra}`;
    }
    
    return sql + ';';
  }

  generateModifyColumnCommand(tableName, column) {
    let sql = `ALTER TABLE \`${tableName}\` MODIFY COLUMN \`${column.name}\` ${column.type}`;
    
    if (column.nullable === 'NO') {
      sql += ' NOT NULL';
    }
    
    if (column.defaultValue !== null) {
      sql += ` DEFAULT ${column.defaultValue}`;
    }
    
    if (column.extra) {
      sql += ` ${column.extra}`;
    }
    
    return sql + ';';
  }

  generateCreateIndexCommand(index) {
    const uniqueKeyword = index.unique ? 'UNIQUE ' : '';
    const columns = index.columns.map(col => `\`${col}\``).join(', ');
    return `CREATE ${uniqueKeyword}INDEX \`${index.name}\` ON \`${index.table}\` (${columns});`;
  }

  async checkAndReport() {
    console.log(chalk.blue('🔍 Checking what dev has that main is missing...\n'));

    const missingTables = [];
    const missingColumns = [];
    const differentColumns = [];
    const missingIndexes = [];

    const devTables = await this.getTables(this.devDb);
    const mainTables = await this.getTables(this.mainDb);

    console.log(chalk.yellow(`📋 Found ${devTables.length} tables in dev database\n`));

    // Check each dev table
    for (const table of devTables) {
      if (!mainTables.includes(table)) {
        console.log(chalk.cyan(`Checking table: ${table}`));
        console.log(chalk.red(`  ❌ Missing in main`));
        missingTables.push(table);
      } else {
        // Check columns
        const devColumns = await this.getTableColumns(this.devDb, table);
        const mainColumns = await this.getTableColumns(this.mainDb, table);
        const mainColumnNames = mainColumns.map(col => col.name);

        let tableMissingColumns = [];
        let tableDifferentColumns = [];

        for (const devColumn of devColumns) {
          const mainColumn = mainColumns.find(col => col.name === devColumn.name);

          if (!mainColumn) {
            tableMissingColumns.push({ table, column: devColumn });
            missingColumns.push({ table, column: devColumn });
          } else {
            // Check if column definition is different
            const differences = this.compareColumns(devColumn, mainColumn);
            if (differences.length > 0) {
              tableDifferentColumns.push({ table, column: devColumn, differences });
              differentColumns.push({ table, column: devColumn, differences });
            }
          }
        }

        // Check indexes
        const devIndexes = await this.getTableIndexes(this.devDb, table);
        const mainIndexes = await this.getTableIndexes(this.mainDb, table);
        const mainIndexNames = mainIndexes.map(idx => idx.name);

        let tableMissingIndexes = [];

        for (const devIndex of devIndexes) {
          if (!mainIndexNames.includes(devIndex.name)) {
            tableMissingIndexes.push(devIndex);
            missingIndexes.push(devIndex);
          }
        }

        // Only log table if there are issues
        if (tableMissingColumns.length > 0 || tableDifferentColumns.length > 0 || tableMissingIndexes.length > 0) {
          console.log(chalk.cyan(`Checking table: ${table}`));
          console.log(chalk.green(`  ✅ Table exists in main`));

          if (tableMissingColumns.length > 0 || tableDifferentColumns.length > 0) {
            console.log(chalk.gray(`  � Checking ${devColumns.length} columns...`));
            
            for (const { column } of tableMissingColumns) {
              console.log(chalk.red(`    ❌ Missing column: ${column.name} (${column.type})`));
            }

            for (const { column, differences } of tableDifferentColumns) {
              console.log(chalk.yellow(`    ⚠️  Different column: ${column.name} - ${differences.join(', ')}`));
            }
          }

          if (tableMissingIndexes.length > 0) {
            console.log(chalk.gray(`  🔍 Checking ${devIndexes.length} indexes...`));
            
            for (const index of tableMissingIndexes) {
              console.log(chalk.red(`    ❌ Missing index: ${index.name}`));
            }
          }
        }
      }
    }

    // Report summary
    console.log(chalk.blue('\n📊 SUMMARY:'));
    console.log(chalk.white(`Total tables in dev: ${devTables.length}`));
    console.log(chalk.white(`Missing tables in main: ${missingTables.length}`));
    console.log(chalk.white(`Missing columns in main: ${missingColumns.length}`));
    console.log(chalk.white(`Different columns in main: ${differentColumns.length}`));
    console.log(chalk.white(`Missing indexes in main: ${missingIndexes.length}`));

    // Show commands to fix missing items
    if (missingTables.length > 0 || missingColumns.length > 0 || differentColumns.length > 0 || missingIndexes.length > 0) {
      console.log(chalk.blue('\n📋 COMMANDS TO COPY/PASTE TO FIX:\n'));

      // Missing tables
      if (missingTables.length > 0) {
        console.log(chalk.yellow('-- Missing Tables --'));
        for (const table of missingTables) {
          const createStatement = await this.getCreateTableStatement(this.devDb, table);
          console.log(chalk.white(createStatement + ';\n'));
        }
      }

      // Missing columns
      if (missingColumns.length > 0) {
        console.log(chalk.yellow('-- Missing Columns --'));
        for (const { table, column } of missingColumns) {
          const alterStatement = this.generateAlterColumnCommand(table, column);
          console.log(chalk.white(alterStatement));
        }
        console.log('');
      }

      // Different columns
      if (differentColumns.length > 0) {
        console.log(chalk.yellow('-- Modified Columns (review carefully before running) --'));
        for (const { table, column, differences } of differentColumns) {
          console.log(chalk.gray(`-- Column ${column.name} in table ${table}: ${differences.join(', ')}`));
          const modifyStatement = this.generateModifyColumnCommand(table, column);
          console.log(chalk.white(modifyStatement));
        }
        console.log('');
      }

      // Missing indexes
      if (missingIndexes.length > 0) {
        console.log(chalk.yellow('-- Missing Indexes --'));
        for (const index of missingIndexes) {
          const createStatement = this.generateCreateIndexCommand(index);
          console.log(chalk.white(createStatement));
        }
      }

      console.log(chalk.red('\n❌ Main database is missing elements from dev!'));
      
      return {
        isInSync: false,
        missingTables,
        missingColumns,
        differentColumns,
        missingIndexes
      };
    } else {
      console.log(chalk.green('\n✅ Main database has everything from dev!'));
      
      return {
        isInSync: true,
        missingTables: [],
        missingColumns: [],
        differentColumns: [],
        missingIndexes: []
      };
    }
  }
}

async function main() {
  const checker = new SchemaChecker();

  try {
    // Set up output capture for GitHub Actions
    checker.setupOutputCapture();

    await checker.connect();
    const result = await checker.checkAndReport();

    // Restore original console methods
    checker.restoreConsoleLog();

    // Generate GitHub Actions summary if running in GitHub Actions
    if (process.env.GITHUB_ACTIONS) {
      const summary = checker.generateActionsSummary(result);

      // Output to GitHub Actions step summary
      core.summary.addRaw(summary).write();

      // Also set outputs
      core.setOutput('is-in-sync', result.isInSync);
      core.setOutput('missing-tables-count', result.missingTables.length);
      core.setOutput('missing-columns-count', result.missingColumns.length);
      core.setOutput('different-columns-count', result.differentColumns.length);
      core.setOutput('missing-indexes-count', result.missingIndexes.length);

      // Post PR comment based on result
      if (!result.isInSync) {
        const body = await checker.generatePRComment(result);

        const github = require('@actions/github');
        await github.getOctokit(process.env.GITHUB_TOKEN).rest.issues.createComment({
          issue_number: github.context.issue.number,
          owner: github.context.repo.owner,
          repo: github.context.repo.repo,
          body
        });
      }
    }

    await checker.disconnect();

    // Don't exit with error code for schema differences - that's a successful comparison
    // Only exit with error code for actual failures (handled in catch block)
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);

    // If running in GitHub Actions, also set failed status
    if (process.env.GITHUB_ACTIONS) {
      core.setFailed(`Schema comparison failed: ${error.message}`);

      // Post PR comment for connection errors
      const body = `## ❌ Schema Comparison Failed

The database schema comparison encountered an error. Please check the [action logs](${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}) for details.

Common issues:
- Database connection problems
- Invalid credentials
- Network connectivity issues
- SSL/TLS configuration problems

---
🤖 *This comment was automatically generated by the MySQL Schema Compare action*`;

      const github = require('@actions/github');
      await github.getOctokit(process.env.GITHUB_TOKEN).rest.issues.createComment({
        issue_number: github.context.issue.number,
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        body
      });
    }

    process.exit(1);
  }
}

main();
