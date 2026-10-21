import { digest } from './Store.js';
import type { PublishConfig } from './Config.js';
export class FeishuError extends Error {
    constructor(readonly reason: string, readonly uncertain = false) { super(reason); }
}
export interface CloudSnapshot {
    title?: string;
    revision: number;
    blocks: {
        id: string;
        text: string;
    }[];
    hash: string;
}
const tokenId = (h: string) => h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-a' + h.slice(17, 20) + '-' + h.slice(20, 32);
export class FeishuDocs {
    private access = '';
    private expires = 0;
    private verified = false;
    private lastWrite = 0;
    constructor(readonly config: PublishConfig, readonly transport: typeof fetch = fetch) { }
    private async json(url: string, init: RequestInit, mutating = false) { let r: Response; try {
        r = await this.transport(url, { ...init, signal: AbortSignal.timeout(15000), redirect: 'error' });
    }
    catch {
        throw new FeishuError('FEISHU_NETWORK_OR_TIMEOUT', mutating);
    } let v: any; try {
        const text = await r.text();
        if (text.length > 8 * 1024 * 1024)
            throw Error();
        v = JSON.parse(text);
    }
    catch {
        throw new FeishuError('FEISHU_RESPONSE_INVALID', mutating);
    } if (!r.ok || v.code && v.code !== 0) {
        if (r.status === 401 || [99991661, 99991663, 99991668].includes(v.code)) {
            this.access = '';
            this.verified = false;
        }
        throw new FeishuError(`FEISHU_HTTP_${r.status}_CODE_${Number(v.code) || 0}`, mutating && r.status >= 500);
    } return v; }
    private async auth() { if (this.access && this.expires > Date.now())
        return; const secret = process.env[this.config.secretEnv]; if (!secret)
        throw new FeishuError('FEISHU_APP_SECRET_MISSING'); const v = await this.json('https://accounts.feishu.cn/oauth/v3/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', client_id: this.config.appId, client_secret: secret }) }); if (typeof v.access_token !== 'string' || !Number.isFinite(v.expires_in) || v.expires_in < 60)
        throw new FeishuError('FEISHU_TOKEN_RESPONSE_INVALID'); this.access = v.access_token; this.expires = Date.now() + (v.expires_in - 60) * 1000; this.verified = false; }
    async api(route: string, method = 'GET', body?: unknown) { await this.auth(); if (!this.verified) {
        const v = await this.json('https://open.feishu.cn/open-apis/tenant/v2/tenant/query', { headers: { Authorization: 'Bearer ' + this.access } });
        if (v.data?.tenant?.tenant_key !== this.config.tenant)
            throw new FeishuError('FEISHU_TENANT_MISMATCH');
        this.verified = true;
    } if (method !== 'GET') {
        const wait = Math.max(0, 360 - (Date.now() - this.lastWrite));
        if (wait)
            await new Promise(r => setTimeout(r, wait));
        this.lastWrite = Date.now();
    } const v = await this.json('https://open.feishu.cn/open-apis/' + route, { method, headers: { Authorization: 'Bearer ' + this.access, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, method !== 'GET'); return v.data ?? {}; }
    async doctor() { await this.auth(); await this.api('tenant/v2/tenant/query'); return { tenant: this.config.tenant, authenticated: true }; }
    async folderMembers(folder: string, allowed: string[]) { const v = await this.api(`drive/v1/permissions/${encodeURIComponent(folder)}/members?type=folder&fields=*`); if (!Array.isArray(v.items))
        throw new FeishuError('FEISHU_FOLDER_MEMBERS_UNVERIFIED'); for (const m of v.items) {
        if (m.member_type === 'appid' && m.member_id === this.config.appId || m.member_type === 'openchat' && m.member_id === this.config.serviceGroupId)
            continue;
        if (m.member_type !== 'openid' || !allowed.includes(m.member_id))
            throw new FeishuError('FEISHU_FOLDER_UNEXPECTED_MEMBER');
    } }
    async find(folder: string, title: string) { let page = '', found: string[] = []; for (let i = 0; i < 100; i++) {
        const q = new URLSearchParams({ folder_token: folder, page_size: '200', ...(page ? { page_token: page } : {}) }), v = await this.api('drive/v1/files?' + q);
        if (!Array.isArray(v.files))
            throw new FeishuError('FEISHU_FOLDER_LIST_INVALID');
        found.push(...v.files.filter((f: any) => typeof f.name === 'string' && f.name.includes(title) && f.type === 'docx').map((f: any) => f.token));
        if (!v.has_more)
            return found;
        if (!v.next_page_token || v.next_page_token === page)
            throw new FeishuError('FEISHU_FOLDER_PAGINATION_INVALID');
        page = v.next_page_token;
    } throw new FeishuError('FEISHU_FOLDER_PAGE_LIMIT'); }
    async create(folder: string, title: string) { const v = await this.api('docx/v1/documents', 'POST', { folder_token: folder, title }), id = v.document?.document_id; if (typeof id !== 'string' || !id)
        throw new FeishuError('FEISHU_CREATE_RESPONSE_INVALID', true); return id; }
    async permissions(document: string, employee: string, leaders: string[], audit = false) { await this.api(`drive/v2/permissions/${encodeURIComponent(document)}/public?type=docx`, 'PATCH', { external_access_entity: 'closed', link_share_entity: 'closed', share_entity: 'same_tenant', manage_collaborator_entity: 'collaborator_full_access', security_entity: 'only_full_access', copy_entity: 'only_full_access' }); const members = [{ member_type: 'openid', member_id: employee, perm: audit ? 'view' : 'edit' }, ...leaders.filter(x => x !== employee).map(x => ({ member_type: 'openid', member_id: x, perm: 'view' }))]; const current = await this.api(`drive/v1/permissions/${encodeURIComponent(document)}/members?type=docx&fields=*`); if (!Array.isArray(current.items))
        throw new FeishuError('FEISHU_DOCUMENT_MEMBERS_UNVERIFIED'); const known = new Map(current.items.map((m: any) => [m.member_type + ':' + m.member_id, m])); for (const m of current.items) {
        if (m.member_type === 'appid' && m.member_id === this.config.appId || m.member_type === 'openchat' && m.member_id === this.config.serviceGroupId)
            continue;
        if (m.member_type !== 'openid' || !members.some(x => x.member_id === m.member_id))
            throw new FeishuError('FEISHU_DOCUMENT_UNEXPECTED_MEMBER');
    } const missing = members.filter(m => !known.has('openid:' + m.member_id)); if (missing.length)
        await this.api(`drive/v1/permissions/${encodeURIComponent(document)}/members/batch_create?type=docx&need_notification=false`, 'POST', { members: missing }); for (const m of members) {
        const old = known.get('openid:' + m.member_id) as any;
        if (old && old.perm !== m.perm)
            await this.api(`drive/v1/permissions/${encodeURIComponent(document)}/members/${encodeURIComponent(m.member_id)}?type=docx&need_notification=false`, 'PUT', { member_type: 'openid', perm: m.perm });
    } }
    async snapshot(document: string): Promise<CloudSnapshot> { const meta = await this.api(`docx/v1/documents/${encodeURIComponent(document)}`), revision = meta.document?.revision_id; if (!Number.isSafeInteger(revision))
        throw new FeishuError('FEISHU_REVISION_MISSING'); let page = '', blocks: CloudSnapshot['blocks'] = []; for (let i = 0; i < 1000; i++) {
        const q = new URLSearchParams({ page_size: '200', document_revision_id: String(revision), ...(page ? { page_token: page } : {}) }), v = await this.api(`docx/v1/documents/${encodeURIComponent(document)}/blocks?` + q);
        if (!Array.isArray(v.items))
            throw new FeishuError('FEISHU_BLOCKS_INVALID');
        for (const b of v.items) {
            const obj = b.text ?? b.heading1 ?? b.heading2 ?? b.heading3 ?? b.bullet ?? b.ordered ?? b.quote ?? b.todo ?? b.code;
            const text = (obj?.elements ?? []).map((e: any) => e.text_run?.content ?? '').join('');
            blocks.push({ id: b.block_id, text });
        }
        if (!v.has_more) {
            const after = await this.api(`docx/v1/documents/${encodeURIComponent(document)}`);
            if (after.document?.revision_id !== revision)
                throw new FeishuError('FEISHU_CONCURRENT_EDIT');
            return { title: meta.document.title, revision, blocks, hash: digest({ title: meta.document.title, blocks }) };
        }
        if (!v.page_token || v.page_token === page)
            throw new FeishuError('FEISHU_BLOCK_PAGINATION_INVALID');
        page = v.page_token;
    } throw new FeishuError('FEISHU_DOCUMENT_PAGE_LIMIT'); }
    async append(document: string, revision: number, marker: string, text: string) { const chunks: string[] = []; for (let at = 0; at < text.length; at += 1800)
        chunks.push(text.slice(at, at + 1800)); if (chunks.length > 40)
        throw new FeishuError('FEISHU_APPEND_PART_TOO_LARGE'); const children = [marker, ...chunks].map(content => ({ block_type: 2, text: { elements: [{ text_run: { content } }] } })); return this.api(`docx/v1/documents/${encodeURIComponent(document)}/blocks/${encodeURIComponent(document)}/children?document_revision_id=${revision}&client_token=${tokenId(digest(marker))}`, 'POST', { children, index: -1 }); }
    async provision(name: string) { return this.api('drive/v1/files/create_folder', 'POST', { name, folder_token: '' }); }
}
