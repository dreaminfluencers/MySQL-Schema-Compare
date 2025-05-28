const mysql = require('mysql2/promise');
const chalk = require('chalk');
const core = require('@actions/core');

class SchemaChecker {
  constructor() {
    this.mainDb = null;
    this.devDb = null;
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
      return false;
    } else {
      console.log(chalk.green('\n✅ Main database has everything from dev!'));
      return true;
    }
  }
}

async function main() {
  const checker = new SchemaChecker();

  try {
    await checker.connect();
    const isInSync = await checker.checkAndReport();
    process.exit(isInSync ? 0 : 1);
  } catch (error) {
    console.error(chalk.red('❌ Error:', error.message));
    process.exit(1);
  } finally {
    await checker.disconnect();
  }
}

main();
