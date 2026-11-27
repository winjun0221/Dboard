# DBoard

A database tool for Windows. Connect to SQLite, MySQL, MariaDB, PostgreSQL and SQL Server to browse tables, run SQL and edit data.

[한국어](README.md)

![SQL editor](docs/editor.png)

## Download

Get it from [Releases](https://github.com/winjun0221/dboard/releases/latest).

- `DBoard-Setup-<version>.exe` — installer (downloads new versions automatically)
- `DBoard-<version>-portable.exe` — runs without installing (no auto-update)

No Java or database client is needed. The app isn't code-signed yet, so if Windows SmartScreen warns on first launch, choose "More info → Run anyway".

## Supported databases

| Type | Also works with |
|---|---|
| SQLite | a single file (`.db`, `.sqlite`) |
| MySQL · MariaDB | MySQL-compatible databases such as TiDB |
| PostgreSQL | PostgreSQL-compatible databases such as CockroachDB and TimescaleDB |
| SQL Server | Azure SQL |

## Features

- **Connections** — save, duplicate and color connections, test before saving, SSH tunnel (password or private key), SSL, **production marking** (editors start in manual commit, data-changing statements ask first, red markers), **read-only connections**, **connection folders**, export and import the connection list (without passwords), **session manager** (see connections and running queries on the server, cancel a query or kill a session), **server status** (connections, queries and transactions per second, lock waits — graphs refreshed every 2 seconds), **users and privileges** (list users and their privileges, create, change passwords, grant/revoke, drop — passwords never appear in previews or the query history)
- **Explorer** — database → schema → tables and views → columns and indexes, **procedures, functions, triggers, sequences and events** (double-click to open the source in an editor), table search, rename, empty or drop tables and views (shows the SQL first)
- **Table designer** — create tables and edit columns (name, type, NULL, default, auto-increment, comment), primary key, indexes and foreign keys. Preview the ALTER statements before running them (for changes SQLite can't do with ALTER, the table is rebuilt and the data copied)
- **SQL editor** — syntax highlighting, autocomplete as you type (accept with `Tab`; table names, columns of the tables in FROM, `alias.column`), run the statement at the cursor or the selection (`Ctrl+Enter`), run the whole script (`Alt+X`), cancel, query history, **manual commit** (commit and rollback buttons), **format SQL** (`Ctrl+Shift+F`), **execution plan** (`Ctrl+Shift+E`, without running — drawn as a tree with cost bars), **query variables** (`:name`, `${name}` — asks for values before running), **code templates** (`sel`, `cnt`, `ins`, `upd`, `del` + `Tab`), `Ctrl+click` a table name to open its data, hover for its columns
- **SQL script files** — save (`Ctrl+S`) and open (`Ctrl+O`) `.sql` files, script list (scripts folder and recent files), open editors come back when you restart
- **Result grid** — smooth with tens of thousands of rows, click to sort, copy cells or ranges (paste straight into Excel), sum/avg/min/max of the selection, record view, export to CSV, Excel, JSON, Markdown or INSERT statements
- **Edit table data** — edit cells, add and delete rows, undo (`Ctrl+Z`), preview the SQL before saving, save in one transaction (everything is rolled back if anything fails), follow foreign keys, copy rows as INSERT/UPDATE/DELETE, value viewer (pretty JSON, images, hex, save to file)
- **Global search** — find table, view, column and procedure names across all databases of a connection, or values in the table data of a schema (opens the table filtered to those rows)
- **ER diagram** — tables and foreign keys of a schema as a diagram (referenced tables laid out on the left), drag to move (positions remembered), zoom, find, show only the tables related to one table, save as PNG or SVG
- **Schema compare** — compare table structures of two databases or schemas of the same kind, see the differences, and run per-table SQL that makes the target match the source
- **Data transfer** — copy tables to another database, even of a different kind (e.g. MySQL → PostgreSQL). Missing tables are created with converted types, parent tables go first, one transaction per table
- **DDL and import** — view and copy the CREATE statement, import CSV, Excel (xlsx, pick a sheet) or JSON (UTF-8 and EUC-KR detected automatically, column mapping)
- **SQL dump and SQL files** — export a database, schema or table as structure (DDL) and data (INSERT) into a `.sql` file (foreign-key order, auto-increment values and computed columns handled so it loads into another database), and run a `.sql` file statement by statement (stops and rolls back on error)
- Korean and English UI, light and dark themes

![Editing table data](docs/data.png)

## Security

- Passwords are encrypted with your Windows account (DPAPI) and can't be read by other users or PCs. Turn off "Save password" to be asked on every connect.
- The SSH server's host key is remembered on first connect; the connection is refused if it changes.
- `UPDATE` and `DELETE` without `WHERE` ask for confirmation before running.
- Edited values are sent as parameters (`?`, `$1`), never pasted into the SQL.

## Shortcuts

| Key | Action |
|---|---|
| `Ctrl+Enter` | Run the selection, or the statement at the cursor |
| `Alt+X` | Run the whole script |
| `Ctrl+Space` · `Tab` | Show · accept autocomplete |
| `Ctrl+/` | Toggle comment |
| `Ctrl+Shift+F` · `Ctrl+Shift+E` | Format SQL · execution plan |
| `Ctrl+S` · `Ctrl+Shift+S` · `Ctrl+O` | Save as SQL file · save as · open |
| `Ctrl+click` | On a table name in the editor: open its data |
| `Ctrl+]` | New SQL editor |
| `Ctrl+W` · `Ctrl+Tab` | Close tab · next tab |
| `Ctrl+S` · `Ctrl+Z` | Save table data or table design · undo |
| `Ctrl+C` · `Ctrl+Shift+C` | Copy results · copy with column names |

## Building

Requires Node.js 24.

```bash
npm install
npm run dev        # run in development
npm test           # tests
npm run test:db    # real-server tests against MySQL, MariaDB, PostgreSQL and SQL Server in Docker
npm run e2e        # UI tests that launch the app
npm run dist       # installer → release/
```

MIT license. Licenses of bundled third-party packages are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
