/*
 * Shared fetch wrapper for the admin frontend.
 * Ported 1:1 from public/index.html (function API, lines 3913-3949) — same
 * behaviour: attaches the Bearer token, parses JSON, and handles 401 by clearing
 * the session and redirecting to login.
 *
 * Token/role/user live in sessionStorage. The original kept them in module-level
 * vars (TOKEN/ROLE/USER); here we read/write sessionStorage directly so the
 * wrapper is self-contained and importable. Pages may still mirror them locally.
 */

const TOKEN_KEY = 'admin_token';

export function getToken() {
    return sessionStorage.getItem(TOKEN_KEY) || '';
}

export function setSession({ token, role, user } = {}) {
    if (token !== undefined) sessionStorage.setItem(TOKEN_KEY, token);
    if (role !== undefined) sessionStorage.setItem('admin_role', role);
    if (user !== undefined) sessionStorage.setItem('admin_user', user);
}

export function clearSession() {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem('admin_role');
    sessionStorage.removeItem('admin_user');
}

/**
 * Call the license-server API. `path` is appended to `/api`.
 * Resolves with parsed JSON, rejects with the parsed error body.
 * On 401 (except for the login endpoints) it clears the session and
 * redirects to the login page, mirroring the original showLogin() flow.
 */
export function API(path, opts) {
    opts = opts || {};
    const token = getToken();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;

    return fetch('/api' + path, Object.assign({ headers }, opts)).then(function (r) {
        const contentType = r.headers.get('content-type') || '';
        const hasJson = contentType.includes('application/json');
        return (
            hasJson
                ? r.json().catch(function () {
                      return {};
                  })
                : Promise.resolve({})
        ).then(function (d) {
            if (r.status === 401) {
                const isLoginEndpoint =
                    path === '/admin/login' ||
                    path === '/admin/login/2fa' ||
                    path === '/portal/login';
                if (isLoginEndpoint) {
                    throw d;
                }
                clearSession();
                // Original called showLogin() in the SPA; in the multi-page Astro
                // build we navigate to the dedicated login page instead.
                window.location.href = '/login';
                throw { message: 'Sitzung abgelaufen. Bitte erneut einloggen.' };
            }
            if (!r.ok) throw d;
            return d;
        });
    });
}
