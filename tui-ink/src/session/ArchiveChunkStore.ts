import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { serialize, deserialize } from 'node:v8';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createSHA256, type IHasher } from 'hash-wasm';
import type { Entry } from './Journal.js';
import type { ArchiveRef } from './Storage.js';
import { archiveEntries } from './ArchiveStream.js';
const require = createRequire(import.meta.url), codec = require('pako/lib/zlib/inflate.js'), ZStream = require('pako/lib/zlib/zstream.js');
const FORMAT = `relay-gzip-1:pako-2.1.0:hash-wasm-4.12.0:node-${process.versions.node.split('.')[0]}`;
const sha = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
class Unsupported extends Error {
}
class Quota extends Error {
}
interface ParserState {
    buffer: string;
    pending: Uint8Array;
    header: boolean;
    position: number;
    entryStart: number;
    depth: number;
    quoted: boolean;
    escaped: boolean;
    first: boolean;
    afterComma: boolean;
    ended: boolean;
    count: number;
    previous: number;
    hash: Uint8Array;
}
/** Serializable canonical parser. UTF-8's at most three pending bytes are part
 * of the checkpoint, as are a partial JSON record and the archive digest state. */
class Parser {
    state: ParserState;
    private constructor(readonly ref: ArchiveRef, readonly hash: IHasher, state?: ParserState) { this.state = state ?? { buffer: '', pending: new Uint8Array(), header: false, position: 0, entryStart: -1, depth: 0, quoted: false, escaped: false, first: true, afterComma: false, ended: false, count: 0, previous: ref.from - 1, hash: new Uint8Array() }; if (state)
        hash.load(state.hash); }
    static async create(ref: ArchiveRef, state?: ParserState) { return new Parser(ref, await createSHA256(), state); }
    snapshot() { return { ...this.state, hash: this.hash.save() }; }
    feed(bytes: Uint8Array, final = false) {
        const s = this.state, data = Buffer.concat([s.pending, bytes]);
        let end = data.length;
        if (!final) {
            let start = end - 1;
            while (start >= Math.max(0, end - 3) && (data[start]! & 192) === 128)
                start--;
            if (start >= 0) {
                const lead = data[start]!, width = lead >= 240 ? 4 : lead >= 224 ? 3 : lead >= 192 ? 2 : 1;
                if (end - start < width)
                    end = start;
            }
        }
        s.pending = Uint8Array.from(data.subarray(end));
        s.buffer += data.subarray(0, end).toString('utf8');
        const entries: Entry[] = [], stringToken = /["\\]/g;
        if (!s.header) {
            const at = s.buffer.indexOf('"entries":[');
            if (at < 0) {
                if (s.buffer.length > 4096 || final)
                    throw new Unsupported('Unsupported archive header');
                return entries;
            }
            const prefix = s.buffer.slice(0, at + 11), canonical = JSON.stringify({ version: 1, from: this.ref.from, to: this.ref.to, lastHash: this.ref.lastHash }).slice(0, -1) + ',"entries":[';
            if (prefix !== canonical)
                throw new Unsupported('Unsupported archive header');
            this.hash.update(prefix);
            s.buffer = s.buffer.slice(prefix.length);
            s.header = true;
        }
        while (s.position < s.buffer.length && !s.ended) {
            let c = s.buffer[s.position]!;
            if (s.entryStart < 0) {
                if (c === ']') {
                    if (s.afterComma)
                        throw Error('Invalid archive separator');
                    s.ended = true;
                    break;
                }
                if (c === ',') {
                    if (s.first || s.afterComma)
                        throw Error('Invalid archive separator');
                    s.afterComma = true;
                    s.position++;
                    if (s.position === s.buffer.length) {
                        s.buffer = '';
                        s.position = 0;
                        break;
                    }
                }
                if (s.buffer[s.position] !== '{' || (!s.first && !s.afterComma))
                    throw Error('Invalid archive entry');
                s.entryStart = s.position;
                s.depth = 0;
                s.quoted = false;
                s.escaped = false;
            }
            if (s.quoted) {
                if (s.escaped) { s.position++; s.escaped = false; continue; }
                stringToken.lastIndex = s.position;
                const token = stringToken.exec(s.buffer);
                if (!token) { s.position = s.buffer.length; break; }
                s.position = token.index;
            }
            c = s.buffer[s.position++]!;
            if (s.quoted) {
                if (s.escaped)
                    s.escaped = false;
                else if (c === '\\')
                    s.escaped = true;
                else if (c === '"')
                    s.quoted = false;
            }
            else if (c === '"')
                s.quoted = true;
            else if (c === '{' || c === '[')
                s.depth++;
            else if (c === '}' || c === ']')
                s.depth--;
            if (s.depth === 0 && !s.quoted) {
                const raw = s.buffer.slice(s.entryStart, s.position), entry = JSON.parse(raw) as Entry;
                if (JSON.stringify(entry) !== raw || !Number.isSafeInteger(entry.seq) || entry.seq <= s.previous || entry.seq < this.ref.from || entry.seq > this.ref.to)
                    throw Error('Memory archive entry integrity failure');
                this.hash.update((s.first ? '' : ',') + raw);
                s.first = false;
                s.afterComma = false;
                s.previous = entry.seq;
                s.count++;
                s.buffer = s.buffer.slice(s.position);
                s.position = 0;
                s.entryStart = -1;
                entries.push(entry);
            }
        }
        if (final) {
            this.hash.update(']}');
            if (s.pending.length || !s.ended || s.buffer !== `],"digest":"${this.ref.digest}"}` || this.hash.digest('hex') !== this.ref.digest || s.count !== this.ref.events)
                throw Error('Memory archive integrity failure');
        }
        return entries;
    }
}
interface Snapshot {
    format: string;
    identity: string;
    stream: any;
    offset: number;
    inputCount: number;
    inputChain: string;
    parser: ParserState;
    chunks: number;
    chain: string;
    verified: boolean;
}
export interface ArchiveMetrics {
    inflatedBytes: number;
    compressedBytesRead: number;
    validatedCompressedBytes: number;
    resumedOffset: number;
    resumedSeq: number;
    checkpoints: number;
    cacheHits: number;
    chunksRead: number;
    quotaFallbacks: number;
}
/** Disposable, quota-bound cache. Never yields entries until gzip CRC and the
 * archive's own digest have both verified. Sources themselves are never changed. */
export class ArchiveChunkStore {
    readonly metrics: ArchiveMetrics = { inflatedBytes: 0, compressedBytesRead: 0, validatedCompressedBytes: 0, resumedOffset: 0, resumedSeq: 0, checkpoints: 0, cacheHits: 0, chunksRead: 0, quotaFallbacks: 0 };
    private db?: DatabaseSync;
    private file: string;
    constructor(root: string, readonly budget: () => number, readonly progress?: (offset: number, total: number, seq: number, metrics: ArchiveMetrics) => void) { this.file = path.join(root, '.spawn/transcript-cache/archive-cache.sqlite'); }
    get bytes() { try {
        return fs.statSync(this.file).size;
    }
    catch {
        return 0;
    } }
    private open() { if (this.db)
        return this.db; fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 }); const open = () => { const db = new DatabaseSync(this.file); try {
        db.exec('PRAGMA auto_vacuum=FULL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,state BLOB NOT NULL,hash TEXT NOT NULL,touched INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS chunks(id TEXT NOT NULL,n INTEGER NOT NULL,first_seq INTEGER NOT NULL,last_seq INTEGER NOT NULL,data TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(id,n)); CREATE INDEX IF NOT EXISTS source_age ON sources(touched); CREATE INDEX IF NOT EXISTS chunk_ranges ON chunks(id,last_seq); CREATE TABLE IF NOT EXISTS inputs(id TEXT NOT NULL,n INTEGER NOT NULL,size INTEGER NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(id,n));');
        return db;
    }
    catch (e) {
        db.close();
        throw e;
    } }; try {
        this.db = open();
    }
    catch (e) {
        if (!/malformed|not a database/.test(String(e)))
            throw e;
        fs.unlinkSync(this.file);
        this.db = open();
    } if (process.platform !== 'win32')
        fs.chmodSync(this.file, 0o600); return this.db; }
    /** Called under the transcript index's writer lock before a page query. */
    trim() { if (this.bytes <= this.budget())
        return; const db = this.open(); db.exec('BEGIN IMMEDIATE'); try {
        for (const row of db.prepare('SELECT id FROM sources ORDER BY touched').all() as {
            id: string;
        }[]) {
            db.prepare('DELETE FROM inputs WHERE id=?').run(row.id);
            db.prepare('DELETE FROM chunks WHERE id=?').run(row.id);
            db.prepare('DELETE FROM sources WHERE id=?').run(row.id);
            const allocated = Number((db.prepare('PRAGMA page_count').get() as any).page_count) - Number((db.prepare('PRAGMA freelist_count').get() as any).freelist_count);
            if (allocated * Number((db.prepare('PRAGMA page_size').get() as any).page_size) <= this.budget())
                break;
        }
        db.exec('COMMIT');
    }
    catch (e) {
        db.exec('ROLLBACK');
        throw e;
    } if (this.bytes > this.budget()) {
        this.close();
        fs.unlinkSync(this.file);
    } }
    close() { this.db?.close(); this.db = undefined; }
    private reset(id: string) { const db = this.open(); db.exec('BEGIN IMMEDIATE'); try {
        db.prepare('DELETE FROM inputs WHERE id=?').run(id);
        db.prepare('DELETE FROM chunks WHERE id=?').run(id);
        db.prepare('DELETE FROM sources WHERE id=?').run(id);
        db.exec('COMMIT');
    }
    catch (e) {
        db.exec('ROLLBACK');
        throw e;
    } }
    private load(id: string, identity: string): Snapshot | undefined { const db = this.open(), row = db.prepare('SELECT state,hash FROM sources WHERE id=?').get(id) as {
        state: Uint8Array;
        hash: string;
    } | undefined; if (!row)
        return; try {
        if (sha(row.state) !== row.hash)
            throw Error('state digest');
        const s = deserialize(row.state) as Snapshot;
        if (s.format !== FORMAT || s.identity !== identity || s.chunks < 0 || s.offset < 0)
            throw Error('cache format');
        let chain = '', n = 0, last = 0;
        for (const r of db.prepare('SELECT n,first_seq,last_seq,hash FROM chunks WHERE id=? ORDER BY n').iterate(id) as Iterable<any>) {
            if (r.n !== n++ || r.first_seq <= last || r.last_seq < r.first_seq)
                throw Error('chunk order');
            last = r.last_seq;
            chain = sha(chain + r.hash);
        }
        if (n !== s.chunks || chain !== s.chain)
            throw Error('chunk root');
        let inputChain = '', inputCount = 0, inputBytes = 0;
        for (const r of db.prepare('SELECT n,size,hash FROM inputs WHERE id=? ORDER BY n').iterate(id) as Iterable<any>) {
            if (r.n !== inputCount++ || !Number.isSafeInteger(r.size) || r.size < 1 || r.size > 65536 || !(/^[a-f0-9]{64}$/).test(r.hash))
                throw Error('input order');
            inputBytes += r.size;
            inputChain = sha(inputChain + r.size + ':' + r.hash);
        }
        if (inputCount !== s.inputCount || inputBytes !== s.offset || inputChain !== s.inputChain)
            throw Error('input root');
        return s;
    }
    catch {
        this.reset(id);
        return;
    } }
    private save(id: string, s: Snapshot, entries: Entry[], inputs: {
        n: number;
        size: number;
        hash: string;
    }[]) {
        const db = this.open();
        db.exec('BEGIN IMMEDIATE');
        try {
            for (const input of inputs)
                db.prepare('INSERT INTO inputs VALUES(?,?,?,?)').run(id, input.n, input.size, input.hash);
            if (entries.length) {
                const data = entries.map(e => JSON.stringify(e)).join('\n'), hash = sha(data);
                db.prepare('INSERT INTO chunks VALUES(?,?,?,?,?,?)').run(id, s.chunks++, entries[0]!.seq, entries.at(-1)!.seq, data, hash);
                s.chain = sha(s.chain + hash);
            }
            const bytes = serialize(s);
            db.prepare('INSERT OR REPLACE INTO sources VALUES(?,?,?,?)').run(id, bytes, sha(bytes), Date.now());
            const used = () => (Number((db.prepare('PRAGMA page_count').get() as any).page_count) - Number((db.prepare('PRAGMA freelist_count').get() as any).freelist_count)) * Number((db.prepare('PRAGMA page_size').get() as any).page_size);
            if (used() > this.budget())
                for (const row of db.prepare('SELECT id FROM sources WHERE id<>? ORDER BY touched').iterate(id) as Iterable<{
                    id: string;
                }>) {
                    if (used() <= this.budget())
                        break;
                    db.prepare('DELETE FROM inputs WHERE id=?').run(row.id);
                    db.prepare('DELETE FROM chunks WHERE id=?').run(row.id);
                    db.prepare('DELETE FROM sources WHERE id=?').run(row.id);
                }
            // FULL auto-vacuum reclaims freed pages at commit, so eviction really makes
            // room without retaining an over-budget cache file.
            if (used() > this.budget())
                throw new Quota('Archive cache quota');
            db.exec('COMMIT');
            this.metrics.checkpoints++;
        }
        catch (e) {
            db.exec('ROLLBACK');
            throw e;
        }
    }
    async *entries(fd: number, size: number, ref: ArchiveRef, after = 0, onChunk?: (seq: number, hash: string) => unknown): AsyncGenerator<Entry> {
        if (this.budget() < 128 * 1024) {
            this.metrics.quotaFallbacks++;
            yield* archiveEntries(fd, size, ref);
            return;
        }
        const stat = fs.fstatSync(fd), identity = JSON.stringify([ref, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]), id = sha(identity);
        let saved = this.load(id, identity);
        if (saved) {
            let valid = true, offset = 0;
            for (const r of this.open().prepare('SELECT size,hash FROM inputs WHERE id=? ORDER BY n').iterate(id) as Iterable<{
                size: number;
                hash: string;
            }>) {
                const b = Buffer.alloc(r.size);
                let n = 0;
                while (n < b.length) {
                    const read = await new Promise<number>((resolve, reject) => fs.read(fd, b, n, b.length - n, offset + n, (e, n) => e ? reject(e) : resolve(n)));
                    if (!read)
                        break;
                    n += read;
                }
                this.metrics.validatedCompressedBytes += n;
                if (n !== b.length || sha(b) !== r.hash) {
                    valid = false;
                    break;
                }
                offset += n;
            }
            if (!valid) {
                this.reset(id);
                saved = undefined;
            }
        }
        try {
            if (saved?.verified)
                this.metrics.cacheHits++;
            else {
                const parser = await Parser.create(ref, saved?.parser);
                let stream = saved?.stream, offset = saved?.offset ?? 0, chunks = saved?.chunks ?? 0, chain = saved?.chain ?? '', inputCount = saved?.inputCount ?? 0, inputChain = saved?.inputChain ?? '', inputs: {
                    n: number;
                    size: number;
                    hash: string;
                }[] = [], entries: Entry[] = [], outputSince = 0, inputSince = 0;
                if (stream) {
                    this.metrics.resumedOffset = offset - stream.avail_in;
                    this.metrics.resumedSeq = parser.state.previous;
                }
                else {
                    stream = new ZStream();
                    if (codec.inflateInit2(stream, 31) !== 0)
                        throw Error('Cannot initialize gzip');
                }
                let done = false;
                while (!done) {
                    if (!stream.avail_in && offset < size) {
                        const b = Buffer.alloc(Math.min(65536, size - offset)), n = await new Promise<number>((resolve, reject) => fs.read(fd, b, 0, b.length, offset, (e, n) => e ? reject(e) : resolve(n)));
                        if (!n)
                            throw Error('History source truncated');
                        const inputHash = sha(b.subarray(0, n));
                        inputs.push({ n: inputCount++, size: n, hash: inputHash });
                        inputChain = sha(inputChain + n + ':' + inputHash);
                        inputSince += n;
                        stream.input = Uint8Array.from(b.subarray(0, n));
                        stream.next_in = 0;
                        stream.avail_in = n;
                        offset += n;
                        this.metrics.compressedBytesRead += n;
                    }
                    stream.output = new Uint8Array(65536);
                    stream.next_out = 0;
                    stream.avail_out = 65536;
                    const before = stream.avail_in, status = codec.inflate(stream, 0), n = stream.next_out;
                    this.metrics.inflatedBytes += n;
                    outputSince += n;
                    entries.push(...parser.feed(stream.output.subarray(0, n)));
                    stream.output = null;
                    stream.next_out = 0;
                    stream.avail_out = 0;
                    if (status === 1) {
                        if (stream.avail_in || offset < size) { // Concatenated gzip members retain the same logical JSON parser.
                            const input = stream.input, next = stream.next_in, available = stream.avail_in;
                            stream = new ZStream();
                            codec.inflateInit2(stream, 31);
                            stream.input = input;
                            stream.next_in = next;
                            stream.avail_in = available;
                        }
                        else {
                            entries.push(...parser.feed(new Uint8Array(), true));
                            done = true;
                        }
                    }
                    else if (status !== 0 && status !== -5)
                        throw Error('Memory archive gzip integrity failure: ' + stream.msg);
                    else if (!n && before === stream.avail_in && offset === size)
                        throw Error('Memory archive gzip was truncated');
                    if (outputSince >= 512 * 1024 || inputSince >= 512 * 1024 || done) {
                        const s: Snapshot = { format: FORMAT, identity, stream, offset, inputCount, inputChain, parser: done ? { ...parser.state, hash: new Uint8Array() } : parser.snapshot(), chunks, chain, verified: done };
                        this.save(id, s, entries, inputs);
                        chunks = s.chunks;
                        chain = s.chain;
                        saved = s;
                        entries = [];
                        inputs = [];
                        outputSince = 0;
                        inputSince = 0;
                        this.progress?.(offset - stream.avail_in, size, parser.state.previous, this.metrics);
                        await new Promise<void>(r => setImmediate(r));
                    }
                }
            }
        }
        catch (e) {
            if (e instanceof Quota || e instanceof Unsupported) {
                if (e instanceof Unsupported)
                    this.reset(id);
                else
                    this.metrics.quotaFallbacks++;
                yield* archiveEntries(fd, size, ref);
                return;
            }
            this.reset(id);
            throw e;
        }
        // Read only chunks overlapping the requested suffix. A cache payload is never
        // trusted merely because its manifest/metadata survived a previous process.
        const db = this.open();
        for (const row of db.prepare('SELECT data,hash FROM chunks WHERE id=? AND last_seq>? ORDER BY n').iterate(id, after) as Iterable<{
            data: string;
            hash: string;
        }>) {
            if (sha(row.data) !== row.hash) {
                this.reset(id);
                throw Error('Transcript cache row integrity failure');
            }
            this.metrics.chunksRead++;
            let last: Entry | undefined;
            for (const line of row.data.split('\n')) {
                const e = JSON.parse(line) as Entry;
                if (e.seq > after) {
                    yield e;
                    last = e;
                }
            }
            if (last)
                await onChunk?.(last.seq, last.hash);
        }
    }
}
