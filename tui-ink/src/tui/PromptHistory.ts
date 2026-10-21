import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {configPath} from '../config.js';

export interface PromptRecord {id:number; text:string; cwd:string; session:string; created:string}
export const promptSession = randomUUID();
function open() {
  const file=path.join(path.dirname(configPath()),'prompt-history.sqlite');
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const db=new DatabaseSync(file);
  if(process.platform!=='win32')fs.chmodSync(file,0o600);
  db.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS prompts(id INTEGER PRIMARY KEY,text TEXT NOT NULL,normalized TEXT NOT NULL,cwd TEXT NOT NULL,session TEXT NOT NULL,created TEXT NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS prompt_search USING fts5(normalized,content='prompts',content_rowid='id',tokenize='trigram');
    CREATE TRIGGER IF NOT EXISTS prompt_insert AFTER INSERT ON prompts BEGIN INSERT INTO prompt_search(rowid,normalized) VALUES(new.id,new.normalized); END;`);
  return db;
}
/** Never index authentication commands or obvious pasted credentials. */
export function canRememberPrompt(text:string) {
  return !!text.trim() && text.length<=100_000 &&
    !/^\s*\/(?:connect|login|feishu|web)\b/i.test(text) &&
    !/(?:\b(?:api[_-]?key|authorization|access[_-]?token|password)\s*[:=]|\bBearer\s+\S+|\bsk-[a-z0-9_-]{8,})/i.test(text);
}
export function rememberPrompt(text:string,cwd=process.cwd(),session:string=promptSession) {
  if(!canRememberPrompt(text))return false;
  const db=open();
  try {db.prepare('INSERT INTO prompts(text,normalized,cwd,session,created) VALUES(?,?,?,?,?)').run(text,text.toLowerCase(),cwd,session,new Date().toISOString());return true;}
  finally{db.close();}
}
export function searchPrompts(query:string,limit=50):PromptRecord[] {
  const db=open(),q=query.toLowerCase().slice(0,2000),n=Math.max(1,Math.min(100,Math.floor(limit)||50));
  try{
    if(Array.from(q).length>=3)return db.prepare(`SELECT p.id,p.text,p.cwd,p.session,p.created FROM prompt_search s JOIN prompts p ON p.id=s.rowid WHERE prompt_search MATCH ? ORDER BY p.id DESC LIMIT ?`).all('"'+q.replace(/"/g,'""')+'"',n) as unknown as PromptRecord[];
    return db.prepare('SELECT id,text,cwd,session,created FROM prompts WHERE instr(normalized,?)>0 ORDER BY id DESC LIMIT ?').all(q,n) as unknown as PromptRecord[];
  }finally{db.close();}
}
