import type { Store } from '../service/store.ts';
import type { SlackConnection } from './types.ts';

export class ConnectionStore {
  constructor(privateStore: Store) {
    this.store = privateStore;
    this.store.db.exec('CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  }
  private store: Store;
  list(): SlackConnection[] {
    return (this.store.db.prepare('SELECT data FROM connections').all() as {data:string}[]).map(row => JSON.parse(row.data)).sort((a,b) => b.createdAt-a.createdAt);
  }
  current() { return this.list().find(c => !c.retired); }
  get(id:string) { return this.list().find(c => c.id === id); }
  save(connection:SlackConnection) {
    connection.updatedAt=Date.now();
    this.store.db.prepare('INSERT INTO connections VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(connection.id,JSON.stringify(connection));
  }
}
