const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin'
};

const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS gi_app_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT (datetime('now'))) STRICT;
CREATE TABLE IF NOT EXISTS gi_companies (id TEXT PRIMARY KEY,code TEXT NOT NULL UNIQUE COLLATE NOCASE,name TEXT NOT NULL,phone TEXT NOT NULL DEFAULT '',email TEXT NOT NULL DEFAULT '',address TEXT NOT NULL DEFAULT '',public_count INTEGER NOT NULL DEFAULT 0,plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','business')),subscription_start TEXT NOT NULL,subscription_end TEXT NOT NULL,subscription_status TEXT NOT NULL DEFAULT 'active' CHECK (subscription_status IN ('active','suspended')),created_at TEXT NOT NULL,updated_at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS gi_accounts (id TEXT PRIMARY KEY,company_id TEXT NOT NULL,username TEXT NOT NULL UNIQUE COLLATE NOCASE,password_hash TEXT NOT NULL,password_salt TEXT NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'Gestionnaire',is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0,1)),active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,FOREIGN KEY (company_id) REFERENCES gi_companies(id) ON DELETE CASCADE) STRICT;
CREATE INDEX IF NOT EXISTS idx_gi_accounts_company ON gi_accounts(company_id);
CREATE INDEX IF NOT EXISTS idx_gi_accounts_username ON gi_accounts(username COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS gi_company_state_meta (company_id TEXT PRIMARY KEY,version INTEGER NOT NULL DEFAULT 1,chunk_count INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,FOREIGN KEY (company_id) REFERENCES gi_companies(id) ON DELETE CASCADE) STRICT;
CREATE TABLE IF NOT EXISTS gi_company_state_chunks (company_id TEXT NOT NULL,version INTEGER NOT NULL,chunk_index INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY (company_id,version,chunk_index),FOREIGN KEY (company_id) REFERENCES gi_companies(id) ON DELETE CASCADE) STRICT;
CREATE INDEX IF NOT EXISTS idx_gi_state_chunks_lookup ON gi_company_state_chunks(company_id,version,chunk_index);
`;

let schemaReady = false;

export async function onRequest(context) {
  const { request, env } = context;
  try {
    validateBindings(env);
    await ensureSchema(env);
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/?/, '');
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') return new Response(null, { status: 204 });
    if (method !== 'GET' && method !== 'HEAD') assertSameOrigin(request);

    if (path === 'health' && method === 'GET') return health(env);
    if (path === 'auth/login' && method === 'POST') return login(request, env);
    if (path === 'auth/logout' && method === 'POST') return logout(request, env);
    if (path === 'session' && method === 'GET') return sessionBootstrap(request, env);
    if (path === 'companies' && method === 'POST') return createCompany(request, env);
    if (path === 'public/companies' && method === 'GET') return publicCompanies(env);

    let match = path.match(/^public\/companies\/([^/]+)$/);
    if (match && method === 'GET') return publicCompany(env, decodeURIComponent(match[1]));
    match = path.match(/^public\/visits\/([^/]+)$/);
    if (match && method === 'POST') return createPublicVisit(request, env, decodeURIComponent(match[1]));
    match = path.match(/^public\/properties\/([^/]+)\/([^/]+)\/engagement$/);
    if (match && method === 'POST') return recordPublicEngagement(request, env, decodeURIComponent(match[1]), decodeURIComponent(match[2]));

    if (path === 'state' && method === 'GET') return getCompanyState(request, env);
    if (path === 'state' && method === 'PUT') return putCompanyState(request, env);
    if (path === 'company/admin-credentials' && method === 'PUT') return updateAdminCredentials(request, env);

    if (path === 'users' && method === 'POST') return createUser(request, env);
    match = path.match(/^users\/([^/]+)$/);
    if (match && method === 'PUT') return updateUser(request, env, decodeURIComponent(match[1]));
    if (match && method === 'DELETE') return deleteUser(request, env, decodeURIComponent(match[1]));
    match = path.match(/^users\/([^/]+)\/status$/);
    if (match && method === 'PATCH') return updateUserStatus(request, env, decodeURIComponent(match[1]));

    if (path === 'super/companies' && method === 'GET') return superCompanies(request, env);
    match = path.match(/^super\/companies\/([^/]+)\/subscription$/);
    if (match && method === 'PATCH') return superSubscription(request, env, decodeURIComponent(match[1]));
    match = path.match(/^super\/companies\/([^/]+)$/);
    if (match && method === 'DELETE') return superDeleteCompany(request, env, decodeURIComponent(match[1]));
    if (path === 'super/credentials' && method === 'PUT') return superCredentials(request, env);
    if (path === 'super/migrate-localstorage' && method === 'POST') return migrateLocalStorage(request, env);

    return fail(404, 'Route API introuvable.', 'NOT_FOUND');
  } catch (error) {
    console.error(error);
    if (error instanceof ApiError) return fail(error.status, error.message, error.code, error.details);
    return fail(500, 'Erreur interne du serveur.', 'INTERNAL_ERROR', safeError(error));
  }
}

class ApiError extends Error {
  constructor(status, message, code = 'ERROR', details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function validateBindings(env) {
  if (!env.D1IM) throw new ApiError(500, 'Binding D1IM manquant.', 'D1_BINDING_MISSING');
  if (!env.KVIM) throw new ApiError(500, 'Binding KVIM manquant.', 'KV_BINDING_MISSING');
  if (!env.SUPER_ADMIN_PASSWORD) throw new ApiError(500, 'Secret Cloudflare manquant : SUPER_ADMIN_PASSWORD.', 'SECRET_MISSING');
}

async function ensureSchema(env) {
  if (schemaReady) return;
  await env.D1IM.exec(SCHEMA_SQL);
  await ensureSuperAdmin(env);
  schemaReady = true;
}

async function ensureSuperAdmin(env) {
  const row = await env.D1IM.prepare("SELECT value FROM gi_app_settings WHERE key='super_admin'").first();
  if (row?.value) return;
  const username = String(env.SUPER_ADMIN_USERNAME || 'megaglobal0777').trim();
  const credentials = await makePasswordRecord(String(env.SUPER_ADMIN_PASSWORD));
  const value = JSON.stringify({ username, ...credentials });
  await env.D1IM.prepare("INSERT OR IGNORE INTO gi_app_settings(key,value,updated_at) VALUES('super_admin',?,?)")
    .bind(value, now()).run();
}

async function health(env) {
  const db = await env.D1IM.prepare('SELECT COUNT(*) AS count FROM gi_companies').first();
  await env.KVIM.get('health:probe');
  return ok({
    status: 'ok',
    database: 'D1IM',
    kv: 'KVIM',
    companies: Number(db?.count || 0),
    secretConfigured: Boolean(env.SUPER_ADMIN_PASSWORD),
    timestamp: now()
  });
}

async function login(request, env) {
  const body = await readJson(request, 64 * 1024);
  const username = requiredText(body.username, 'Identifiant', 120);
  const password = requiredText(body.password, 'Mot de passe', 512);
  const superAdmin = await getSuperAdmin(env);

  let session;
  let payload;
  if (username.toLowerCase() === superAdmin.username.toLowerCase() && await verifyPassword(password, superAdmin)) {
    session = { kind: 'super', user: { username: superAdmin.username, role: 'Super Administrateur', isAdmin: true } };
    payload = { kind: 'super', user: session.user, companies: await listCompaniesSummary(env) };
  } else {
    const account = await env.D1IM.prepare('SELECT * FROM gi_accounts WHERE username = ? COLLATE NOCASE').bind(username).first();
    if (!account || !(await verifyPassword(password, account))) throw new ApiError(401, 'Identifiant ou mot de passe incorrect.', 'INVALID_CREDENTIALS');
    if (!Number(account.active)) throw new ApiError(403, 'Ce compte utilisateur est désactivé.', 'ACCOUNT_DISABLED');
    const company = await getCompany(env, account.company_id);
    assertSubscription(company);
    const stateResult = await readState(env, company.id);
    const state = sanitizeState(stateResult.state || {}, company);
    const user = accountToUser(account);
    state.loginHistory = Array.isArray(state.loginHistory) ? state.loginHistory : [];
    state.loginHistory.unshift({ date: now(), user: user.username, role: user.role, company: company.code });
    state.loginHistory = state.loginHistory.slice(0, 100);
    const saved = await writeState(env, company.id, state, stateResult.version);
    session = { kind: 'company', companyId: company.id, user };
    payload = { kind: 'company', user, company: publicCompanyRecord(company), state: saved.state, version: saved.version };
  }

  const token = randomToken();
  const ttl = clampInt(env.SESSION_TTL_SECONDS, 3600, 2592000, 604800);
  await env.KVIM.put(`session:${token}`, JSON.stringify({ ...session, createdAt: now() }), { expirationTtl: ttl });
  return ok(payload, 200, { 'set-cookie': sessionCookie(token, ttl, request) });
}

async function logout(request, env) {
  const token = getCookie(request, 'gi_session');
  if (token) await env.KVIM.delete(`session:${token}`);
  return ok({ loggedOut: true }, 200, { 'set-cookie': clearSessionCookie(request) });
}

async function sessionBootstrap(request, env) {
  const session = await requireSession(request, env);
  if (session.kind === 'super') return ok({ kind: 'super', user: session.user, companies: await listCompaniesSummary(env) });
  const company = await getCompany(env, session.companyId);
  assertSubscription(company);
  const result = await readState(env, company.id);
  return ok({ kind: 'company', user: session.user, company: publicCompanyRecord(company), state: sanitizeState(result.state || {}, company), version: result.version });
}

async function createCompany(request, env) {
  const body = await readJson(request, 512 * 1024);
  const name = requiredText(body.name, 'Nom de l’entreprise', 160);
  const username = requiredText(body.username, 'Identifiant administrateur', 120);
  const password = requiredText(body.password, 'Mot de passe', 512);
  if (password.length < 4) throw new ApiError(400, 'Le mot de passe doit contenir au moins 4 caractères.', 'WEAK_PASSWORD');
  await assertUsernameAvailable(env, username);

  const id = crypto.randomUUID();
  const code = await uniqueCompanyCode(env, name);
  const start = dateOnly();
  const end = addDays(start, 21);
  const createdAt = now();
  const phone = cleanText(body.phone, 80);
  const email = cleanText(body.email, 180);
  const address = cleanText(body.address, 250);
  const passwordRecord = await makePasswordRecord(password);
  const state = sanitizeState(body.state || {}, { id, code, name, phone, email, address });
  state.settings = { ...(state.settings || {}), companyId: id, companyCode: code, agency: name, phone, email, address, adminUser: username, adminPass: '', apiUrl: '' };
  state.users = [];

  try {
    await env.D1IM.prepare('INSERT INTO gi_companies(id,code,name,phone,email,address,public_count,plan,subscription_start,subscription_end,subscription_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,\'free\',?,?,\'active\',?,?)')
      .bind(id, code, name, phone, email, address, countPublicProperties(state), start, end, createdAt, createdAt).run();
    await env.D1IM.prepare('INSERT INTO gi_accounts(id,company_id,username,password_hash,password_salt,name,role,is_admin,active,created_at,updated_at) VALUES(?,?,?,?,?,?,\'Administrateur\',1,1,?,?)')
      .bind(crypto.randomUUID(), id, username, passwordRecord.password_hash, passwordRecord.password_salt, 'Administrateur principal', createdAt, createdAt).run();
    const saved = await createInitialState(env, id, state);
    const user = { id: 'admin', name: 'Administrateur principal', username, role: 'Administrateur', isAdmin: true, active: true };
    const token = randomToken();
    const ttl = clampInt(env.SESSION_TTL_SECONDS, 3600, 2592000, 604800);
    await env.KVIM.put(`session:${token}`, JSON.stringify({ kind: 'company', companyId: id, user, createdAt }), { expirationTtl: ttl });
    return ok({ kind: 'company', user, company: publicCompanyRecord({ id, code, name, phone, email, address, plan: 'free', subscription_start: start, subscription_end: end, subscription_status: 'active', created_at: createdAt }), state: saved.state, version: saved.version }, 201, { 'set-cookie': sessionCookie(token, ttl, request) });
  } catch (error) {
    await env.D1IM.prepare('DELETE FROM gi_companies WHERE id=?').bind(id).run().catch(() => {});
    if (String(error).includes('UNIQUE')) throw new ApiError(409, 'Cet identifiant est déjà utilisé.', 'USERNAME_EXISTS');
    throw error;
  }
}

async function publicCompanies(env) {
  const result = await env.D1IM.prepare("SELECT id,code,name,phone,email,address,public_count,plan,subscription_start,subscription_end,subscription_status,created_at FROM gi_companies WHERE subscription_status='active' ORDER BY name COLLATE NOCASE").all();
  const companies = (result.results || []).filter(isSubscriptionActive).map((company) => ({ ...publicCompanyRecord(company), count: Number(company.public_count || 0) }));
  return ok({ companies }, 200, { 'cache-control': 'public, max-age=30' });
}

async function publicCompany(env, companyId) {
  const company = await getCompany(env, companyId);
  assertSubscription(company);
  const result = await readState(env, company.id);
  const state = sanitizeState(result.state || {}, company);
  return ok({ company: publicCompanyRecord(company), state: publicState(state) }, 200, { 'cache-control': 'public, max-age=15' });
}

async function createPublicVisit(request, env, companyId) {
  const body = await readJson(request, 128 * 1024);
  const company = await getCompany(env, companyId);
  assertSubscription(company);
  const name = requiredText(body.name, 'Nom', 160);
  const phone = requiredText(body.phone, 'Téléphone', 80);
  const result = await readState(env, companyId);
  const state = sanitizeState(result.state || {}, company);
  const properties = Array.isArray(state.properties) ? state.properties : [];
  if (body.propertyId && !properties.some((p) => p.id === body.propertyId && p.published && !p.archived)) throw new ApiError(400, 'Bien public introuvable.', 'PROPERTY_NOT_FOUND');
  const visits = Array.isArray(state.visits) ? state.visits : [];
  const ref = cleanText(body.ref, 50) || nextRef('VIS', visits);
  const visit = {
    id: crypto.randomUUID(), ref, propertyId: cleanText(body.propertyId, 100), name, phone,
    whatsapp: cleanText(body.whatsapp, 80), email: cleanText(body.email, 180), date: cleanText(body.date, 20) || dateOnly(),
    time: cleanText(body.time, 20) || '10:00', message: cleanText(body.message, 2000), contactMethod: cleanText(body.contactMethod, 50) || 'Téléphone',
    status: 'Nouvelle', source: 'Catalogue', createdAt: dateOnly()
  };
  state.visits.unshift(visit);
  state.notifications = Array.isArray(state.notifications) ? state.notifications : [];
  state.notifications.unshift({ id: crypto.randomUUID(), date: now(), message: `Nouvelle demande de visite ${ref}`, type: 'info', read: false });
  state.notifications = state.notifications.slice(0, 100);
  const saved = await writeState(env, companyId, state, result.version);
  return ok({ visit, version: saved.version }, 201);
}

async function recordPublicEngagement(request, env, companyId, propertyId) {
  const body = await readJson(request, 16 * 1024);
  const type = body.type === 'favorite' ? 'favorite' : 'view';
  const company = await getCompany(env, companyId);
  assertSubscription(company);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await readState(env, companyId);
    const state = sanitizeState(result.state || {}, company);
    const property = state.properties.find((item) => item.id === propertyId && item.published && !item.archived);
    if (!property) throw new ApiError(404, 'Bien public introuvable.', 'PROPERTY_NOT_FOUND');
    if (type === 'favorite') property.favorites = Number(property.favorites || 0) + 1;
    else property.views = Number(property.views || 0) + 1;
    try {
      const saved = await writeState(env, companyId, state, result.version);
      return ok({ type, views: Number(property.views || 0), favorites: Number(property.favorites || 0), version: saved.version });
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'VERSION_CONFLICT' || attempt === 2) throw error;
    }
  }
  throw new ApiError(409, 'Interaction non enregistrée. Réessayez.', 'VERSION_CONFLICT');
}

async function getCompanyState(request, env) {
  const session = await requireCompanySession(request, env);
  const company = await getCompany(env, session.companyId);
  assertSubscription(company);
  const result = await readState(env, company.id);
  return ok({ company: publicCompanyRecord(company), state: sanitizeState(result.state || {}, company), version: result.version });
}

async function putCompanyState(request, env) {
  const session = await requireCompanySession(request, env);
  const body = await readJson(request, clampInt(env.MAX_STATE_BYTES, 1048576, 25000000, 12582912));
  const expectedVersion = Number(body.version);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new ApiError(400, 'Version de synchronisation invalide.', 'INVALID_VERSION');
  const company = await getCompany(env, session.companyId);
  assertSubscription(company);
  const state = sanitizeState(body.state || {}, company);
  const saved = await writeState(env, company.id, state, expectedVersion);
  await updateCompanyProfile(env, company.id, state);
  return ok({ state: saved.state, version: saved.version, updatedAt: now() });
}

async function updateAdminCredentials(request, env) {
  const session = await requireCompanyAdmin(request, env);
  const body = await readJson(request, 64 * 1024);
  const username = requiredText(body.username, 'Identifiant administrateur', 120);
  const password = cleanText(body.password, 512);
  const account = await env.D1IM.prepare('SELECT * FROM gi_accounts WHERE company_id=? AND is_admin=1').bind(session.companyId).first();
  if (!account) throw new ApiError(404, 'Compte administrateur introuvable.', 'ADMIN_NOT_FOUND');
  if (username.toLowerCase() !== String(account.username).toLowerCase()) await assertUsernameAvailable(env, username, account.id);
  const updatedAt = now();
  if (password) {
    if (password.length < 4) throw new ApiError(400, 'Le mot de passe doit contenir au moins 4 caractères.', 'WEAK_PASSWORD');
    const record = await makePasswordRecord(password);
    await env.D1IM.prepare('UPDATE gi_accounts SET username=?,password_hash=?,password_salt=?,updated_at=? WHERE id=?')
      .bind(username, record.password_hash, record.password_salt, updatedAt, account.id).run();
  } else {
    await env.D1IM.prepare('UPDATE gi_accounts SET username=?,updated_at=? WHERE id=?').bind(username, updatedAt, account.id).run();
  }
  session.user.username = username;
  await refreshSession(request, env, session);
  return ok({ user: session.user });
}

async function createUser(request, env) {
  const session = await requireCompanyAdmin(request, env);
  const body = await readJson(request, 64 * 1024);
  const count = await env.D1IM.prepare('SELECT COUNT(*) AS count FROM gi_accounts WHERE company_id=? AND is_admin=0').bind(session.companyId).first();
  if (Number(count?.count || 0) >= 2) throw new ApiError(400, 'La limite de deux utilisateurs est atteinte.', 'USER_LIMIT');
  const username = requiredText(body.username, 'Identifiant', 120);
  const password = requiredText(body.password, 'Mot de passe', 512);
  const name = requiredText(body.name, 'Nom', 160);
  await assertUsernameAvailable(env, username);
  const record = await makePasswordRecord(password);
  const user = { id: crypto.randomUUID(), companyId: session.companyId, username, name, role: allowedRole(body.role), isAdmin: false, active: body.active !== false, createdAt: now(), updatedAt: now() };
  await env.D1IM.prepare('INSERT INTO gi_accounts(id,company_id,username,password_hash,password_salt,name,role,is_admin,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .bind(user.id, session.companyId, username, record.password_hash, record.password_salt, name, user.role, 0, user.active ? 1 : 0, user.createdAt, user.updatedAt).run();
  return ok({ user }, 201);
}

async function updateUser(request, env, userId) {
  const session = await requireCompanyAdmin(request, env);
  const body = await readJson(request, 64 * 1024);
  const account = await getManagedUser(env, session.companyId, userId);
  const username = requiredText(body.username, 'Identifiant', 120);
  const name = requiredText(body.name, 'Nom', 160);
  if (username.toLowerCase() !== String(account.username).toLowerCase()) await assertUsernameAvailable(env, username, account.id);
  const role = allowedRole(body.role);
  const active = body.active !== false;
  const password = cleanText(body.password, 512);
  if (password) {
    const record = await makePasswordRecord(password);
    await env.D1IM.prepare('UPDATE gi_accounts SET username=?,password_hash=?,password_salt=?,name=?,role=?,active=?,updated_at=? WHERE id=? AND company_id=?')
      .bind(username, record.password_hash, record.password_salt, name, role, active ? 1 : 0, now(), userId, session.companyId).run();
  } else {
    await env.D1IM.prepare('UPDATE gi_accounts SET username=?,name=?,role=?,active=?,updated_at=? WHERE id=? AND company_id=?')
      .bind(username, name, role, active ? 1 : 0, now(), userId, session.companyId).run();
  }
  return ok({ user: { id: userId, username, name, role, active, isAdmin: false, updatedAt: now(), createdAt: account.created_at } });
}

async function deleteUser(request, env, userId) {
  const session = await requireCompanyAdmin(request, env);
  await getManagedUser(env, session.companyId, userId);
  await env.D1IM.prepare('DELETE FROM gi_accounts WHERE id=? AND company_id=? AND is_admin=0').bind(userId, session.companyId).run();
  return ok({ deleted: true });
}

async function updateUserStatus(request, env, userId) {
  const session = await requireCompanyAdmin(request, env);
  const body = await readJson(request, 16 * 1024);
  await getManagedUser(env, session.companyId, userId);
  const active = body.active !== false;
  await env.D1IM.prepare('UPDATE gi_accounts SET active=?,updated_at=? WHERE id=? AND company_id=? AND is_admin=0').bind(active ? 1 : 0, now(), userId, session.companyId).run();
  return ok({ active });
}

async function superCompanies(request, env) {
  await requireSuperSession(request, env);
  return ok({ companies: await listCompaniesSummary(env), superAdmin: { username: (await getSuperAdmin(env)).username } });
}

async function superSubscription(request, env, companyId) {
  await requireSuperSession(request, env);
  const body = await readJson(request, 64 * 1024);
  const company = await getCompany(env, companyId);
  let plan = body.plan === 'business' ? 'business' : body.plan === 'free' ? 'free' : company.plan;
  let status = body.status === 'suspended' ? 'suspended' : 'active';
  let start = cleanText(body.start, 20) || company.subscription_start;
  let end = cleanText(body.end, 20) || company.subscription_end;
  const action = cleanText(body.action, 30);
  const today = dateOnly();
  if (action === 'business') {
    const base = company.plan === 'business' && isSubscriptionActive(company) ? company.subscription_end : today;
    plan = 'business'; status = 'active'; start = today; end = addDays(base, 365);
  } else if (action === 'free') {
    plan = 'free'; status = 'active'; start = today; end = addDays(today, 21);
  } else if (action === 'suspend') status = 'suspended';
  else if (action === 'resume') {
    status = 'active';
    if (!isSubscriptionActive({ ...company, subscription_status: status })) end = addDays(today, plan === 'business' ? 365 : 21);
  }
  await env.D1IM.prepare('UPDATE gi_companies SET plan=?,subscription_start=?,subscription_end=?,subscription_status=?,updated_at=? WHERE id=?')
    .bind(plan, start, end, status, now(), companyId).run();
  return ok({ company: publicCompanyRecord({ ...company, plan, subscription_start: start, subscription_end: end, subscription_status: status }) });
}

async function superDeleteCompany(request, env, companyId) {
  await requireSuperSession(request, env);
  const company = await getCompany(env, companyId);
  await env.D1IM.prepare('DELETE FROM gi_companies WHERE id=?').bind(companyId).run();
  return ok({ deleted: true, company: company.name });
}

async function superCredentials(request, env) {
  const session = await requireSuperSession(request, env);
  const body = await readJson(request, 64 * 1024);
  const current = await getSuperAdmin(env);
  const username = requiredText(body.username, 'Identifiant Super Admin', 120);
  const password = cleanText(body.password, 512);
  await assertUsernameAvailable(env, username, '', true);
  let next = { username, password_hash: current.password_hash, password_salt: current.password_salt };
  if (password) next = { username, ...(await makePasswordRecord(password)) };
  await env.D1IM.prepare("UPDATE gi_app_settings SET value=?,updated_at=? WHERE key='super_admin'").bind(JSON.stringify(next), now()).run();
  session.user.username = username;
  await refreshSession(request, env, session);
  return ok({ username });
}

async function migrateLocalStorage(request, env) {
  await requireSuperSession(request, env);
  const body = await readJson(request, 25000000);
  const registry = Array.isArray(body.enterprises) ? body.enterprises : [];
  const states = body.states && typeof body.states === 'object' ? body.states : {};
  let imported = 0;
  let skipped = 0;
  const errors = [];
  for (const record of registry.slice(0, 500)) {
    try {
      const oldState = states[record.id];
      if (!oldState || typeof oldState !== 'object') { skipped++; continue; }
      const settings = oldState.settings || {};
      const name = cleanText(record.name || settings.agency, 160) || 'Entreprise immobilière';
      const oldId = cleanText(record.id, 100) || crypto.randomUUID();
      const exists = await env.D1IM.prepare('SELECT id FROM gi_companies WHERE id=? OR code=? COLLATE NOCASE').bind(oldId, cleanText(record.code, 50)).first();
      if (exists) { skipped++; continue; }
      const id = oldId;
      const code = cleanText(record.code || settings.companyCode, 50) || await uniqueCompanyCode(env, name);
      const createdAt = cleanText(record.createdAt, 40) || now();
      const plan = record.plan === 'business' ? 'business' : 'free';
      const start = cleanText(record.subscriptionStart, 20) || dateOnly();
      const end = cleanText(record.subscriptionEnd, 20) || addDays(start, plan === 'business' ? 365 : 21);
      const status = record.subscriptionStatus === 'suspended' ? 'suspended' : 'active';
      const state = sanitizeState(oldState, { id, code, name, phone: settings.phone || '', email: settings.email || '', address: settings.address || '' });
      const adminUsername = cleanText(settings.adminUser, 120) || `${code.toLowerCase()}-admin`;
      const adminPassword = cleanText(settings.adminPass, 512) || randomToken().slice(0, 16);
      await assertUsernameAvailable(env, adminUsername);
      await env.D1IM.prepare('INSERT INTO gi_companies(id,code,name,phone,email,address,public_count,plan,subscription_start,subscription_end,subscription_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .bind(id, code, name, cleanText(settings.phone, 80), cleanText(settings.email, 180), cleanText(settings.address, 250), countPublicProperties(state), plan, start, end, status, createdAt, now()).run();
      const adminRecord = await makePasswordRecord(adminPassword);
      await env.D1IM.prepare('INSERT INTO gi_accounts(id,company_id,username,password_hash,password_salt,name,role,is_admin,active,created_at,updated_at) VALUES(?,?,?,?,?,?,\'Administrateur\',1,1,?,?)')
        .bind(crypto.randomUUID(), id, adminUsername, adminRecord.password_hash, adminRecord.password_salt, 'Administrateur principal', createdAt, now()).run();
      const users = Array.isArray(oldState.users) ? oldState.users.slice(0, 2) : [];
      for (const user of users) {
        const userName = cleanText(user.username, 120);
        const userPassword = cleanText(user.password, 512);
        if (!userName || !userPassword) continue;
        try {
          await assertUsernameAvailable(env, userName);
          const recordPassword = await makePasswordRecord(userPassword);
          await env.D1IM.prepare('INSERT INTO gi_accounts(id,company_id,username,password_hash,password_salt,name,role,is_admin,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
            .bind(cleanText(user.id, 100) || crypto.randomUUID(), id, userName, recordPassword.password_hash, recordPassword.password_salt, cleanText(user.name, 160) || userName, allowedRole(user.role), 0, user.active === false ? 0 : 1, createdAt, now()).run();
        } catch (error) { errors.push(`${name}: utilisateur ${userName} non importé (${safeError(error)})`); }
      }
      state.settings.adminUser = adminUsername;
      state.settings.adminPass = '';
      state.users = users.map(sanitizeUserRecord);
      await createInitialState(env, id, state);
      imported++;
    } catch (error) {
      errors.push(`${cleanText(record.name, 160) || 'Entreprise'}: ${safeError(error)}`);
    }
  }
  return ok({ imported, skipped, errors: errors.slice(0, 30), companies: await listCompaniesSummary(env) });
}

async function getSuperAdmin(env) {
  const row = await env.D1IM.prepare("SELECT value FROM gi_app_settings WHERE key='super_admin'").first();
  if (!row?.value) throw new ApiError(500, 'Configuration Super Admin absente.', 'SUPER_ADMIN_MISSING');
  return JSON.parse(row.value);
}

async function getCompany(env, id) {
  const company = await env.D1IM.prepare('SELECT * FROM gi_companies WHERE id=?').bind(id).first();
  if (!company) throw new ApiError(404, 'Entreprise introuvable.', 'COMPANY_NOT_FOUND');
  return company;
}

async function listCompaniesSummary(env) {
  const result = await env.D1IM.prepare(`SELECT c.*, (SELECT COUNT(*) FROM gi_accounts a WHERE a.company_id=c.id AND a.is_admin=0) AS user_count FROM gi_companies c ORDER BY c.created_at DESC`).all();
  return (result.results || []).map((company) => ({ ...publicCompanyRecord(company), count: Number(company.public_count || 0), userCount: Number(company.user_count || 0), daysRemaining: subscriptionDays(company), state: isSubscriptionActive(company) ? 'active' : company.subscription_status === 'suspended' ? 'suspended' : 'expired' }));
}

async function readState(env, companyId) {
  const meta = await env.D1IM.prepare('SELECT version,chunk_count FROM gi_company_state_meta WHERE company_id=?').bind(companyId).first();
  if (!meta) return { version: 0, state: null };
  const chunks = await env.D1IM.prepare('SELECT payload FROM gi_company_state_chunks WHERE company_id=? AND version=? ORDER BY chunk_index').bind(companyId, meta.version).all();
  const rows = chunks.results || [];
  if (rows.length !== Number(meta.chunk_count)) throw new ApiError(500, 'État cloud incomplet.', 'STATE_INCOMPLETE');
  try {
    return { version: Number(meta.version), state: JSON.parse(rows.map((row) => row.payload).join('')) };
  } catch (error) {
    throw new ApiError(500, 'État cloud illisible.', 'STATE_INVALID', safeError(error));
  }
}

async function createInitialState(env, companyId, state) {
  const clean = sanitizeState(state, { id: companyId });
  const text = JSON.stringify(clean);
  const chunks = chunkString(text);
  const statements = chunks.map((payload, index) => env.D1IM.prepare('INSERT INTO gi_company_state_chunks(company_id,version,chunk_index,payload) VALUES(?,1,?,?)').bind(companyId, index, payload));
  statements.push(env.D1IM.prepare('INSERT INTO gi_company_state_meta(company_id,version,chunk_count,updated_at) VALUES(?,1,?,?)').bind(companyId, chunks.length, now()));
  await env.D1IM.batch(statements);
  return { version: 1, state: clean };
}

async function writeState(env, companyId, state, expectedVersion) {
  const current = await env.D1IM.prepare('SELECT version FROM gi_company_state_meta WHERE company_id=?').bind(companyId).first();
  if (!current) throw new ApiError(404, 'État cloud introuvable.', 'STATE_NOT_FOUND');
  const currentVersion = Number(current.version);
  if (currentVersion !== Number(expectedVersion)) {
    const latest = await readState(env, companyId);
    throw new ApiError(409, 'Les données ont été modifiées sur un autre appareil.', 'VERSION_CONFLICT', latest);
  }
  const clean = sanitizeState(state, { id: companyId });
  const text = JSON.stringify(clean);
  const nextVersion = currentVersion + 1;
  const chunks = chunkString(text);
  const insertStatements = chunks.map((payload, index) => env.D1IM.prepare('INSERT INTO gi_company_state_chunks(company_id,version,chunk_index,payload) VALUES(?,?,?,?)').bind(companyId, nextVersion, index, payload));
  await env.D1IM.batch(insertStatements);
  const updated = await env.D1IM.prepare('UPDATE gi_company_state_meta SET version=?,chunk_count=?,updated_at=? WHERE company_id=? AND version=?')
    .bind(nextVersion, chunks.length, now(), companyId, currentVersion).run();
  if (Number(updated.meta?.changes || 0) !== 1) {
    await env.D1IM.prepare('DELETE FROM gi_company_state_chunks WHERE company_id=? AND version=?').bind(companyId, nextVersion).run();
    const latest = await readState(env, companyId);
    throw new ApiError(409, 'Les données ont été modifiées sur un autre appareil.', 'VERSION_CONFLICT', latest);
  }
  await env.D1IM.prepare('DELETE FROM gi_company_state_chunks WHERE company_id=? AND version<?').bind(companyId, nextVersion).run();
  return { version: nextVersion, state: clean };
}

async function updateCompanyProfile(env, companyId, state) {
  const settings = state.settings || {};
  await env.D1IM.prepare('UPDATE gi_companies SET name=?,phone=?,email=?,address=?,public_count=?,updated_at=? WHERE id=?')
    .bind(cleanText(settings.agency, 160) || 'Entreprise immobilière', cleanText(settings.phone, 80), cleanText(settings.email, 180), cleanText(settings.address, 250), countPublicProperties(state), now(), companyId).run();
}

async function requireSession(request, env) {
  const token = getCookie(request, 'gi_session');
  if (!token) throw new ApiError(401, 'Session expirée. Veuillez vous reconnecter.', 'UNAUTHENTICATED');
  const value = await env.KVIM.get(`session:${token}`);
  if (!value) throw new ApiError(401, 'Session expirée. Veuillez vous reconnecter.', 'UNAUTHENTICATED');
  try { return JSON.parse(value); } catch { throw new ApiError(401, 'Session invalide.', 'INVALID_SESSION'); }
}

async function requireCompanySession(request, env) {
  const session = await requireSession(request, env);
  if (session.kind !== 'company' || !session.companyId) throw new ApiError(403, 'Accès réservé à une entreprise.', 'FORBIDDEN');
  return session;
}

async function requireCompanyAdmin(request, env) {
  const session = await requireCompanySession(request, env);
  if (!session.user?.isAdmin) throw new ApiError(403, 'Action réservée à l’administrateur de l’entreprise.', 'ADMIN_REQUIRED');
  return session;
}

async function requireSuperSession(request, env) {
  const session = await requireSession(request, env);
  if (session.kind !== 'super') throw new ApiError(403, 'Accès réservé au Super Administrateur.', 'SUPER_ADMIN_REQUIRED');
  return session;
}

async function refreshSession(request, env, session) {
  const token = getCookie(request, 'gi_session');
  if (!token) return;
  const ttl = clampInt(env.SESSION_TTL_SECONDS, 3600, 2592000, 604800);
  await env.KVIM.put(`session:${token}`, JSON.stringify(session), { expirationTtl: ttl });
}

async function getManagedUser(env, companyId, userId) {
  const account = await env.D1IM.prepare('SELECT * FROM gi_accounts WHERE id=? AND company_id=? AND is_admin=0').bind(userId, companyId).first();
  if (!account) throw new ApiError(404, 'Utilisateur introuvable.', 'USER_NOT_FOUND');
  return account;
}

async function assertUsernameAvailable(env, username, excludeAccountId = '', excludeSuper = false) {
  const row = await env.D1IM.prepare('SELECT id FROM gi_accounts WHERE username=? COLLATE NOCASE AND id<>?').bind(username, excludeAccountId || '').first();
  if (row) throw new ApiError(409, 'Cet identifiant est déjà utilisé.', 'USERNAME_EXISTS');
  if (!excludeSuper) {
    const superAdmin = await getSuperAdmin(env);
    if (String(superAdmin.username).toLowerCase() === String(username).toLowerCase()) throw new ApiError(409, 'Cet identifiant est déjà utilisé.', 'USERNAME_EXISTS');
  }
}

function sanitizeState(input, company = {}) {
  const state = input && typeof input === 'object' ? structuredClone(input) : {};
  const arrayKeys = ['properties','owners','tenants','leases','payments','expenses','sales','payouts','visits','users','notifications','activity','loginHistory'];
  for (const key of arrayKeys) if (!Array.isArray(state[key])) state[key] = [];
  state.settings = state.settings && typeof state.settings === 'object' ? state.settings : {};
  state.settings.companyId = company.id || state.settings.companyId || '';
  if (company.code) state.settings.companyCode = company.code;
  if (company.name && !state.settings.agency) state.settings.agency = company.name;
  state.settings.adminPass = '';
  state.settings.apiUrl = '';
  state.users = state.users.map(sanitizeUserRecord).slice(0, 2);
  return state;
}

function sanitizeUserRecord(user) {
  return {
    id: cleanText(user?.id, 100) || crypto.randomUUID(),
    name: cleanText(user?.name, 160),
    username: cleanText(user?.username, 120),
    role: allowedRole(user?.role),
    active: user?.active !== false,
    createdAt: cleanText(user?.createdAt, 50) || now(),
    updatedAt: cleanText(user?.updatedAt, 50) || now()
  };
}

function publicState(state) {
  const settings = state.settings || {};
  return {
    settings: {
      companyId: settings.companyId || '', companyCode: settings.companyCode || '', agency: settings.agency || '', phone: settings.phone || '',
      whatsapp: settings.whatsapp || '', email: settings.email || '', address: settings.address || '', currency: settings.currency || 'FCFA',
      logo: settings.logo || '', primary: settings.primary || '#073c36', accent: settings.accent || '#e0ad32', visitFee: Number(settings.visitFee || 0)
    },
    properties: (state.properties || []).filter((p) => p.published && !p.archived).map((p) => ({ ...p, ownerId: undefined }))
  };
}

function publicCompanyRecord(company) {
  return {
    id: company.id, code: company.code, name: company.name, phone: company.phone || '', email: company.email || '', address: company.address || '',
    plan: company.plan || 'free', subscriptionStart: company.subscription_start || company.subscriptionStart || '', subscriptionEnd: company.subscription_end || company.subscriptionEnd || '',
    subscriptionStatus: company.subscription_status || company.subscriptionStatus || 'active', createdAt: company.created_at || company.createdAt || ''
  };
}

function accountToUser(account) {
  return { id: account.id, name: account.name, username: account.username, role: account.role, isAdmin: Boolean(account.is_admin), active: Boolean(account.active) };
}

function countPublicProperties(state) {
  return (Array.isArray(state.properties) ? state.properties : []).filter((p) => p?.published && !p?.archived).length;
}

function assertSubscription(company) {
  if (!isSubscriptionActive(company)) {
    const status = company.subscription_status === 'suspended' ? 'suspendu' : 'expiré';
    throw new ApiError(403, `L’abonnement de cette entreprise est ${status}.`, 'SUBSCRIPTION_INACTIVE');
  }
}

function isSubscriptionActive(company) {
  if ((company.subscription_status || company.subscriptionStatus) === 'suspended') return false;
  const end = company.subscription_end || company.subscriptionEnd;
  return !end || new Date(`${end}T23:59:59Z`).getTime() >= Date.now();
}

function subscriptionDays(company) {
  if (!isSubscriptionActive(company)) return 0;
  const end = company.subscription_end || company.subscriptionEnd;
  return Math.max(0, Math.floor((new Date(`${end}T23:59:59Z`).getTime() - Date.now()) / 86400000));
}

async function uniqueCompanyCode(env, name) {
  const stem = String(name || 'IMMO').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 3).padEnd(3, 'X');
  for (let n = 1; n < 10000; n++) {
    const code = `${stem}-${String(n).padStart(4, '0')}`;
    const exists = await env.D1IM.prepare('SELECT id FROM gi_companies WHERE code=? COLLATE NOCASE').bind(code).first();
    if (!exists) return code;
  }
  return `${stem}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

async function makePasswordRecord(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt);
  return { password_hash: bytesToBase64(hash), password_salt: bytesToBase64(salt) };
}

async function verifyPassword(password, record) {
  try {
    const salt = base64ToBytes(record.password_salt);
    const expected = base64ToBytes(record.password_hash);
    const actual = await pbkdf2(password, salt);
    return timingSafeEqual(actual, expected);
  } catch { return false; }
}

async function pbkdf2(password, salt) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, material, 256);
  return new Uint8Array(bits);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function chunkString(value, maxChars = 300000) {
  if (!value) return ['{}'];
  const chunks = [];
  for (let start = 0; start < value.length;) {
    let end = Math.min(value.length, start + maxChars);
    if (end < value.length && /[\uD800-\uDBFF]/.test(value.charAt(end - 1))) end--;
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks;
}

async function readJson(request, maxBytes) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length && length > maxBytes) throw new ApiError(413, 'Données trop volumineuses.', 'PAYLOAD_TOO_LARGE');
  let text;
  try { text = await request.text(); } catch { throw new ApiError(400, 'Corps de requête illisible.', 'INVALID_BODY'); }
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new ApiError(413, 'Données trop volumineuses.', 'PAYLOAD_TOO_LARGE');
  try { return text ? JSON.parse(text) : {}; } catch { throw new ApiError(400, 'JSON invalide.', 'INVALID_JSON'); }
}

function assertSameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return;
  if (origin !== new URL(request.url).origin) throw new ApiError(403, 'Origine de requête refusée.', 'ORIGIN_FORBIDDEN');
}

function getCookie(request, name) {
  const cookie = request.headers.get('cookie') || '';
  const found = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : '';
}

function sessionCookie(token, ttl, request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `gi_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttl}${secure}`;
}

function clearSessionCookie(request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `gi_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function requiredText(value, label, maxLength) {
  const text = cleanText(value, maxLength);
  if (!text) throw new ApiError(400, `${label} obligatoire.`, 'VALIDATION_ERROR');
  return text;
}

function cleanText(value, maxLength = 5000) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function allowedRole(value) {
  return ['Gestionnaire', 'Comptable', 'Agent immobilier'].includes(value) ? value : 'Gestionnaire';
}

function nextRef(prefix, list) {
  const max = Math.max(0, ...list.map((item) => Number(String(item?.ref || '').split('-').pop()) || 0));
  return `${prefix}-${String(max + 1).padStart(4, '0')}`;
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
}

function now() { return new Date().toISOString(); }
function dateOnly() { return now().slice(0, 10); }
function addDays(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + Number(days || 0));
  return value.toISOString().slice(0, 10);
}

function ok(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify({ ok: true, ...data }), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

function fail(status, error, code, details) {
  return new Response(JSON.stringify({ ok: false, error, code, ...(details ? { details } : {}) }), { status, headers: JSON_HEADERS });
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').slice(0, 500);
}
