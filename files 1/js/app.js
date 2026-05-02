
// placeholder - renderPOS and selectVariant are defined in the main script below

function staffNormalizeProducts(items) {
            return (Array.isArray(items) ? items : []).map(p => ({
                id: p.id || Date.now(),
                name: p.name || '',
                style: p.style || '',
                color: p.color || '',
                size: p.size || 'N/A',
                barcode: p.barcode || '',
                cost: Number.isFinite(+p.cost) ? +p.cost : 0,
                price: Number.isFinite(+p.price) ? +p.price : 0,
                stock: Number.isFinite(+p.stock) ? +p.stock : 0,
                sales: Number.isFinite(+p.sales) ? +p.sales : 0
            }));
        }


        // =====================================================================
        //  SUPABASE REAL-TIME SYNC ENGINE
        //  ─────────────────────────────────────────────────────────────────────
        //  HOW TO ACTIVATE:
        //  1. Go to https://supabase.com and create a free project
        //  2. Go to Project Settings → API
        //  3. Copy your Project URL and anon/public key into SUPABASE_CONFIG below
        //  4. Run the SQL in the Supabase SQL Editor to create your tables (see
        //     the step-by-step guide provided with this file)
        //  5. Set ENABLE_SUPABASE = true
        //  6. Deploy this file anywhere (GitHub Pages, Netlify, etc.)
        // =====================================================================

        const SUPABASE_CONFIG = {
            url:    'https://pzhbwyylcqqpdzivahnf.supabase.co',   // e.g. https://xyzabc.supabase.co
            anonKey: 'sb_publishable_PYbWgMm2LwGxhhyV9jIabA_TdksAgFM'      // long JWT string from Settings → API
        };

        const ENABLE_SUPABASE = true; // ← set to true after pasting config above

        // ── runtime state ──────────────────────────────────────────────────────
        let supabaseReady = false;
        let sbClient = null;
        let _unsubscribers = [];        // Supabase realtime channel unsubscribers
        let _syncStatus = 'local';      // 'local' | 'connecting' | 'live' | 'error'
        let _pendingSave = false;
        let _saveTimer = null;

        // ── Supabase table names ───────────────────────────────────────────────
        const FS = {
            BIZ:     'erp_biz',
            STAFF:   'erp_staff',
            INV:     'erp_inv',
            SALES:   'erp_sales',
            ACC:     'erp_acc',
            PURCH:   'erp_purch',
            CHAT:    'erp_chat',
            FINANCE: 'erp_finance',
        };
        const FS_STORE_ID = 'store_1'; // change if you have multiple stores

        // ── sync status indicator ──────────────────────────────────────────────
        function setSyncStatus(status, msg) {
            _syncStatus = status;
            const el = document.getElementById('sync-status');
            if (!el) return;
            const map = {
                local:       { icon: '💾', text: 'Local only',    color: '#f39c12' },
                connecting:  { icon: '🔄', text: 'Connecting…',   color: '#3498db' },
                live:        { icon: '🟢', text: 'Live sync',      color: '#27ae60' },
                error:       { icon: '🔴', text: msg || 'Offline', color: '#e74c3c' },
                saving:      { icon: '⬆', text: 'Saving…',        color: '#9b59b6' },
            };
            const s = map[status] || map.local;
            el.innerHTML = `<span style="color:${s.color}; font-size:12px; font-weight:600;">${s.icon} ${s.text}</span>`;
        }

        // ── init ───────────────────────────────────────────────────────────────
        async function initSupabaseSync() {
            if (!ENABLE_SUPABASE) { setSyncStatus('local'); return; }
            setSyncStatus('connecting');
            try {
                if (!window.supabase) throw new Error('Supabase SDK not loaded');
                sbClient = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
                // Verify connection with a lightweight query
                const { error } = await sbClient.from(FS.BIZ).select('id').limit(1);
                if (error) throw error;
                supabaseReady = true;
                setSyncStatus('live');
                await cloudLoad();
                attachRealtimeListeners();
            } catch (e) {
                console.error('Supabase init error:', e);
                setSyncStatus('error', 'Sync error');
                showToast('Running in local-only mode. Check Supabase config.', 'warning');
            }
        }

        // ── real-time listeners: push remote changes → local state → re-render ─
        function attachRealtimeListeners() {
            if (!supabaseReady || !sbClient) return;
            _unsubscribers.forEach(u => u());
            _unsubscribers = [];

            const listen = (table, handler) => {
                const ch = sbClient.channel('rt:' + table)
                    .on('postgres_changes', { event: '*', schema: 'public', table: table, filter: 'store_id=eq.' + FS_STORE_ID },
                        payload => { if (payload.new) handler(payload.new); })
                    .subscribe();
                _unsubscribers.push(() => sbClient.removeChannel(ch));
            };

            // Per-table listeners
            listen(FS.BIZ,     row => { db_biz = row.value || db_biz; fillBusinessForm(); document.getElementById('nav-title').innerText = (db_biz.name || 'WORKSPACE').toUpperCase(); });
            listen(FS.STAFF,   row => {
                db_staff = row.value || db_staff;
                persistLocalOnly();
                // AUTO-LOGOUT: if current user's status changed to suspended/deleted, force logout
                if (user) {
                    const me = db_staff.find(s => s.id === user.id);
                    if (me && me.status !== 'active') {
                        showToast(`Your account has been ${me.status}. You have been logged out.`, 'error');
                        setTimeout(() => { setStaffOnlineStatus(user.id, false); location.reload(); }, 2500);
                        return;
                    }
                    renderStaff();
                }
            });
            listen(FS.INV,     row => { db_inv = staffNormalizeProducts(row.value || db_inv); persistLocalOnly(); if (user) { renderInventory(); renderPOS(); } });
            listen(FS.SALES,   row => { db_sales = row.value || db_sales; persistLocalOnly(); if (user) renderReceipts(); });
            listen(FS.ACC,     row => { db_acc = row.value || db_acc; persistLocalOnly(); if (user) renderAccounting(); });
            listen(FS.PURCH,   row => { db_purch = row.value || db_purch; persistLocalOnly(); if (user) renderProcurement(); });
            listen(FS.FINANCE, row => { db_finance = row.value ?? db_finance; document.getElementById('account-balance-nav').innerText = db_finance.toLocaleString(); persistLocalOnly(); });

            // Chat: listen for new INSERT events
            const chatCh = sbClient.channel('rt:erp_chat')
                .on('postgres_changes', { event: 'INSERT', schema: 'public', table: FS.CHAT },
                    payload => {
                        if (payload.new) {
                            db_chat = [...db_chat, payload.new].sort((a, b) => new Date(a.ts) - new Date(b.ts)).slice(-100);
                            persistLocalOnly();
                            if (user) renderChat();
                        }
                    })
                .subscribe();
            _unsubscribers.push(() => sbClient.removeChannel(chatCh));
        }

        // ── load all data once on start ────────────────────────────────────────
        async function cloudLoad() {
            if (!supabaseReady || !sbClient) return;
            const get = async (table) => {
                const { data } = await sbClient.from(table).select('*').eq('store_id', FS_STORE_ID).maybeSingle();
                return data || null;
            };
            try {
                const [biz, staff, inv, sales, acc, purch, fin] = await Promise.all([
                    get(FS.BIZ), get(FS.STAFF), get(FS.INV),
                    get(FS.SALES), get(FS.ACC), get(FS.PURCH), get(FS.FINANCE)
                ]);
                if (biz)   db_biz     = biz.value   || db_biz;
                if (staff) db_staff   = staff.value  || db_staff;
                if (inv)   db_inv     = staffNormalizeProducts(inv.value || db_inv);
                if (sales) db_sales   = sales.value  || db_sales;
                if (acc)   db_acc     = acc.value    || db_acc;
                if (purch) db_purch   = purch.value  || db_purch;
                if (fin)   db_finance = fin.value    ?? db_finance;
                // Load last 100 chat messages
                const { data: chatRows } = await sbClient.from(FS.CHAT).select('*').order('ts', { ascending: true }).limit(100);
                if (chatRows) db_chat = chatRows;
                persistLocalOnly();
            } catch (e) {
                console.error('cloudLoad error:', e);
                setSyncStatus('error', 'Load failed');
            }
        }

        // ── debounced save: batches rapid updates into one Supabase upsert ──────
        async function cloudSave() {
            persistLocalOnly();
            if (!supabaseReady || !sbClient) return;
            if (_saveTimer) clearTimeout(_saveTimer);
            _saveTimer = setTimeout(async () => {
                setSyncStatus('saving');
                try {
                    const up = (table, value) =>
                        sbClient.from(table).upsert({ store_id: FS_STORE_ID, value }, { onConflict: 'store_id' });
                    await Promise.all([
                        up(FS.BIZ, db_biz), up(FS.STAFF, db_staff), up(FS.INV, db_inv),
                        up(FS.SALES, db_sales), up(FS.ACC, db_acc), up(FS.PURCH, db_purch),
                        up(FS.FINANCE, db_finance)
                    ]);
                    setSyncStatus('live');
                } catch (e) {
                    console.error('cloudSave error:', e);
                    setSyncStatus('error', 'Save failed – retrying');
                    // retry once after 5s
                    setTimeout(cloudSave, 5000);
                }
            }, 800); // debounce: wait 800ms after last change before writing
        }

        // ── chat: each message is its own Supabase row for real-time ────────
        async function cloudSendChat(msg) {
            if (!supabaseReady || !sbClient) return;
            try {
                await sbClient.from(FS.CHAT).insert({
                    ...msg,
                    ts: new Date().toISOString()
                });
            } catch (e) {
                console.warn('Chat send error:', e);
            }
        }

        // ── staff presence via Supabase ───────────────────────────────────────
        async function cloudSetPresence(staffId, isOnline) {
            if (!supabaseReady || !sbClient) return;
            try {
                await sbClient.from('erp_presence').upsert({
                    staff_id: String(staffId),
                    online: isOnline,
                    last_seen: new Date().toISOString(),
                    name: user ? user.name : ''
                }, { onConflict: 'staff_id' });
            } catch (e) { /* silently fail */ }
        }

        // ── presence listener: updates staff online dots via Supabase realtime ───
        function attachPresenceListener() {
            if (!supabaseReady || !sbClient) return;
            const ch = sbClient.channel('rt:erp_presence')
                .on('postgres_changes', { event: '*', schema: 'public', table: 'erp_presence' }, payload => {
                    if (!payload.new) return;
                    const d = payload.new;
                    const idx = db_staff.findIndex(s => String(s.id) === d.staff_id);
                    if (idx > -1) {
                        const ls = d.last_seen ? new Date(d.last_seen).getTime() : 0;
                        const stale = Date.now() - ls > 120000;
                        db_staff[idx].online = d.online && !stale;
                        db_staff[idx].lastSeen = ls;
                    }
                    if (user) renderStaff();
                })
                .subscribe();
            _unsubscribers.push(() => sbClient.removeChannel(ch));
        }

        // ===================== DATABASE & STATE =====================
        let db_biz     = JSON.parse(localStorage.getItem('v72_biz'))     || { name: "", website: "", phone: "", address: "", social: "" };
        let db_staff   = JSON.parse(localStorage.getItem('v72_staff'))   || [{ id: 1, name: "Super Admin", pin: "0000", role: "admin", status: "active", email: "admin@store.com", phone: "", unit: "Management", salesCount: 0 }];
        let db_inv     = staffNormalizeProducts(JSON.parse(localStorage.getItem('v72_inv')) || []);
        let db_acc     = JSON.parse(localStorage.getItem('v72_acc'))     || [];
        let db_purch   = JSON.parse(localStorage.getItem('v72_purch'))   || [];
        let db_chat    = JSON.parse(localStorage.getItem('v72_chat'))    || [];
        let db_sales   = JSON.parse(localStorage.getItem('v72_sales'))   || [];
        let db_finance = parseFloat(localStorage.getItem('v72_finance')) || 0.0;

        let user = null;
        let cart = [];
        let confirmActionCallback = null;
        let lastChatLen = db_chat.length;
        let charts = { sales: null, top: null, profit: null };
        let scannerRunning = false;
        let currentInvoice = null;
        let chatInterval = null;

        // ===================== UTILITIES / TOASTS =====================
        function showToast(message, type = 'success') {
            const container = document.getElementById('toast-container');
            const toast = document.createElement('div');
            toast.className = `toast ${type}`;
            toast.innerText = message;
            container.appendChild(toast);
            setTimeout(() => {
                toast.style.animation = 'fadeOut 0.3s ease-out forwards';
                setTimeout(() => toast.remove(), 300);
            }, 3000);
        }

        function showConfirm(message, callback) {
            document.getElementById('confirm-msg').innerText = message;
            confirmActionCallback = callback;
            document.getElementById('modal-confirm').style.display = 'flex';
        }
        function closeConfirmModal() { document.getElementById('modal-confirm').style.display = 'none'; confirmActionCallback = null; }
        // confirm-yes wired in DOMContentLoaded below

        // ===================== AUTH =====================
        function handleLogin() {
            const pin = document.getElementById('login-pin').value.trim();
            const found = db_staff.find(s => s.pin === pin);
            if (!found) return showToast('Invalid PIN credentials.', 'error');
            if (found.status !== 'active') return showToast(`Account access denied. Status: ${found.status.toUpperCase()}`, 'error');
            user = found;
            document.getElementById('login-screen').style.display = 'none';
            showToast(`Welcome back, ${user.name}!`);
            initUI();
        }

        function showRecover() {
            document.getElementById('login-form-area').style.display = 'none';
            document.getElementById('recover-form-area').style.display = 'block';
        }
        function showLogin() {
            document.getElementById('login-form-area').style.display = 'block';
            document.getElementById('recover-form-area').style.display = 'none';
        }

        function processRecovery() {
            const em = document.getElementById('rec-email').value.trim();
            const ph = document.getElementById('rec-phone').value.trim();
            const s = db_staff.find(x => x.email === em && x.phone === ph);
            if (!s) return showToast('No matching staff record found.', 'error');
            const newPin = Math.floor(1000 + Math.random() * 9000).toString();
            s.pin = newPin;
            persist();
            // Send real email via EmailJS
            sendRealEmail(s.email, s.name, `Your new ERP PIN is: ${newPin}`, 'PIN Recovery');
            showToast(`New PIN sent to ${s.email}`, 'success');
            showLogin();
        }

        // ===================== ONLINE / OFFLINE PRESENCE =====================
        function setStaffOnlineStatus(staffId, isOnline) {
            const idx = db_staff.findIndex(x => x.id === staffId);
            if (idx > -1) {
                db_staff[idx].online = isOnline;
                db_staff[idx].lastSeen = Date.now();
                persistLocalOnly();
            }
            // Also write to Firestore presence collection for cross-device sync
            cloudSetPresence(staffId, isOnline);
        }

        function startPresenceHeartbeat() {
            if (window._presenceInterval) clearInterval(window._presenceInterval);
            // Heartbeat every 60s
            window._presenceInterval = setInterval(() => {
                if (user) cloudSetPresence(user.id, true);
            }, 60000);
            // Mark offline on tab close
            window.addEventListener('beforeunload', () => {
                if (user) cloudSetPresence(user.id, false);
            });
            // Attach Firestore presence listener so all tabs see each other
            attachPresenceListener();
        }

        // ===================== REAL EMAIL (EmailJS) =====================
        // EmailJS free tier - configure with your own keys for production
        const EMAILJS_SERVICE_ID = 'service_erp_demo';
        const EMAILJS_TEMPLATE_ID = 'template_erp_notify';
        const EMAILJS_PUBLIC_KEY = 'YOUR_EMAILJS_PUBLIC_KEY'; // Replace with real key

        function loadEmailJS() {
            if (window.emailjs) return;
            const s = document.createElement('script');
            s.src = 'https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js';
            s.onload = () => { 
                try { emailjs.init({ publicKey: EMAILJS_PUBLIC_KEY }); } catch(e) {}
            };
            document.head.appendChild(s);
        }

        async function sendRealEmail(toEmail, toName, message, subject) {
            if (!toEmail) return;
            loadEmailJS();
            try {
                if (!window.emailjs) {
                    // Fallback: show the PIN in a toast if emailjs not loaded
                    showToast(`Email (demo): ${subject} → ${toEmail}`, 'warning');
                    console.log(`[EMAIL] To: ${toEmail} | Subject: ${subject} | Msg: ${message}`);
                    return;
                }
                await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
                    to_email: toEmail,
                    to_name: toName,
                    subject: subject,
                    message: message,
                    from_name: db_biz.name || 'Enterprise ERP'
                });
                showToast(`Email sent to ${toEmail}!`, 'success');
            } catch (err) {
                showToast(`Email queued (configure EmailJS to send real emails)`, 'warning');
                console.warn('EmailJS error:', err);
            }
        }

        function sendStaffWelcomeEmail(staff) {
            const msg = `Welcome to ${db_biz.name || 'the ERP System'}, ${staff.name}!\n\nYour login PIN is: ${staff.pin}\nRole: ${staff.role}\n\nPlease keep your PIN confidential.`;
            sendRealEmail(staff.email, staff.name, msg, 'Welcome - Your ERP Access Details');
        }

        // ===================== PRODUCT VARIANT ANALYTICS =====================
        function viewVariantAnalytics(productName) {
            const variants = db_inv.filter(p => p.name === productName);
            const modal = document.getElementById('product-analytics-modal');
            const content = document.getElementById('product-analytics-content');
            if (!modal || !content) return;

            // Build per-variant sales from actual db_sales transactions
            const variantSalesMap = {}; // variantId -> {units, revenue, profit}
            variants.forEach(v => { variantSalesMap[v.id] = { units: 0, revenue: 0, profit: 0 }; });

            db_sales.forEach(sale => {
                (sale.items || []).forEach(it => {
                    if (variantSalesMap[it.id] !== undefined) {
                        const v = variants.find(x => x.id == it.id);
                        if (!v) return;
                        variantSalesMap[it.id].units += +it.qty || 0;
                        variantSalesMap[it.id].revenue += (+it.qty || 0) * (+v.price || 0);
                        variantSalesMap[it.id].profit += (+it.qty || 0) * ((+v.price || 0) - (+v.cost || 0));
                    }
                });
            });

            // Aggregate totals
            let totalUnitsSold = 0, totalRevenue = 0, totalProfit = 0;
            variants.forEach(v => {
                totalUnitsSold += variantSalesMap[v.id].units;
                totalRevenue += variantSalesMap[v.id].revenue;
                totalProfit += variantSalesMap[v.id].profit;
            });

            const totalStock = variants.reduce((s, v) => s + (+v.stock || 0), 0);
            const bestVariant = variants.reduce((best, v) =>
                variantSalesMap[v.id].units > variantSalesMap[best.id].units ? v : best, variants[0]);

            // Chart data
            const variantLabels = variants.map(v =>
                [v.style, v.color, v.size !== 'N/A' ? v.size : ''].filter(Boolean).join('/') || 'Default');
            const chartSales = variants.map(v => variantSalesMap[v.id].units);
            const chartStock = variants.map(v => +v.stock || 0);
            const chartRevenue = variants.map(v => variantSalesMap[v.id].revenue);

            // Daily revenue trend for this product (last 14 days)
            const now = Date.now();
            const trendMap = {};
            for (let d = 13; d >= 0; d--) {
                const dt = new Date(now - d * 86400000);
                trendMap[dt.toLocaleDateString()] = 0;
            }
            db_sales.forEach(sale => {
                const saleDate = new Date(sale.timestamp || 0).toLocaleDateString();
                if (trendMap[saleDate] === undefined) return;
                (sale.items || []).forEach(it => {
                    const v = variants.find(x => x.id == it.id);
                    if (v) trendMap[saleDate] += (+it.qty || 0) * (+v.price || 0);
                });
            });

            const bestLabel = bestVariant
                ? [bestVariant.style, bestVariant.color, bestVariant.size !== 'N/A' ? bestVariant.size : ''].filter(Boolean).join('/') || 'Default'
                : 'N/A';

            content.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px; flex-wrap:wrap; gap:10px;">
                    <div>
                        <h3 style="color:var(--odoo-purple); font-size:18px;">${escapeHtml(productName)}</h3>
                        <div class="mini">${variants.length} variant(s) · Analytics from actual sales</div>
                    </div>
                    <button onclick="closeProductAnalytics()" style="background:none;border:none;font-size:22px;cursor:pointer;color:#7f8c8d;padding:0;">✖</button>
                </div>

                <div class="analytics-grid">
                    <div class="a-card"><h4>Total Sold</h4><h2 style="color:var(--odoo-teal);">${totalUnitsSold}</h2><small>units</small></div>
                    <div class="a-card"><h4>Revenue</h4><h2 style="color:#27ae60; font-size:14px;">₦${totalRevenue.toLocaleString()}</h2></div>
                    <div class="a-card"><h4>Profit</h4><h2 style="color:${totalProfit >= 0 ? '#27ae60' : '#e74c3c'}; font-size:14px;">₦${totalProfit.toLocaleString()}</h2></div>
                    <div class="a-card"><h4>Stock Left</h4><h2 style="color:${totalStock > 5 ? 'var(--text-dark)' : '#e74c3c'};">${totalStock}</h2><small>units</small></div>
                    <div class="a-card"><h4>Best Variant</h4><h2 style="font-size:12px; padding-top:6px; line-height:1.3;">${escapeHtml(bestLabel)}</h2><small>${variantSalesMap[bestVariant?.id]?.units || 0} sold</small></div>
                </div>

                <h4 style="margin-bottom:10px; color:#5f6368; font-size:13px; text-transform:uppercase; letter-spacing:0.5px;">Variant Breakdown</h4>
                <div class="table-responsive" style="margin-bottom:18px;">
                    <table>
                        <thead><tr><th>Variant</th><th>Cost</th><th>Price</th><th>Margin</th><th>Sold</th><th>Stock</th><th>Revenue</th></tr></thead>
                        <tbody>
                            ${variants.map(v => {
                                const margin = v.price > 0 ? (((v.price - v.cost) / v.price) * 100).toFixed(1) : '0.0';
                                const vLabel = [v.style, v.color, v.size !== 'N/A' ? v.size : ''].filter(Boolean).join(' · ') || 'Default';
                                const vData = variantSalesMap[v.id];
                                return `<tr>
                                    <td><b>${escapeHtml(vLabel)}</b></td>
                                    <td>₦${(+v.cost || 0).toLocaleString()}</td>
                                    <td>₦${(+v.price || 0).toLocaleString()}</td>
                                    <td class="${+margin >= 20 ? 'margin-good' : 'margin-low'}">${margin}%</td>
                                    <td style="font-weight:800; color:var(--odoo-purple);">${vData.units}</td>
                                    <td><span class="badge ${+v.stock > 5 ? 'badge-active' : +v.stock > 0 ? 'badge-suspended' : 'badge-deleted'}">${v.stock}</span></td>
                                    <td style="color:var(--odoo-teal); font-weight:700;">₦${vData.revenue.toLocaleString()}</td>
                                </tr>`;
                            }).join('')}
                        </tbody>
                    </table>
                </div>

                <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:14px;">
                    <div class="chart-wrap" style="margin-bottom:0;"><h4 style="margin-bottom:8px; font-size:13px;">Units Sold</h4><div style="height:190px;"><canvas id="vsc"></canvas></div></div>
                    <div class="chart-wrap" style="margin-bottom:0;"><h4 style="margin-bottom:8px; font-size:13px;">Revenue Split</h4><div style="height:190px;"><canvas id="vrc"></canvas></div></div>
                </div>
                <div class="chart-wrap"><h4 style="margin-bottom:8px; font-size:13px;">Stock by Variant</h4><div style="height:160px;"><canvas id="vstc"></canvas></div></div>
                <div class="chart-wrap"><h4 style="margin-bottom:8px; font-size:13px;">Revenue Trend (14 days)</h4><div style="height:170px;"><canvas id="vtrendc"></canvas></div></div>
            `;

            modal.style.display = 'flex';

            setTimeout(() => {
                const colors = ['#714B67','#00A09D','#f39c12','#e74c3c','#27ae60','#3498db','#e67e22','#16a085'];
                const opt = (t) => ({ responsive:true, maintainAspectRatio:false, plugins:{ legend:{ position: t==='doughnut'?'bottom':'top', labels:{font:{size:11}} } } });

                const sc = document.getElementById('vsc');
                const rc = document.getElementById('vrc');
                const stc = document.getElementById('vstc');
                const tc = document.getElementById('vtrendc');

                if (sc) new Chart(sc, { type:'doughnut', data:{ labels:variantLabels, datasets:[{ data:chartSales, backgroundColor:colors }] }, options:opt('doughnut') });
                if (rc) new Chart(rc, { type:'doughnut', data:{ labels:variantLabels, datasets:[{ data:chartRevenue, backgroundColor:colors }] }, options:opt('doughnut') });
                if (stc) new Chart(stc, { type:'bar', data:{ labels:variantLabels, datasets:[{ label:'Stock', data:chartStock, backgroundColor:'#00A09D', borderRadius:5 }] }, options:{ ...opt('bar'), plugins:{ legend:{display:false} } } });
                if (tc) new Chart(tc, { type:'line', data:{ labels:Object.keys(trendMap), datasets:[{ label:'Revenue ₦', data:Object.values(trendMap), borderColor:'#714B67', backgroundColor:'rgba(113,75,103,0.08)', tension:0.3, fill:true, pointRadius:3 }] }, options:{ ...opt('line'), plugins:{ legend:{display:false} } } });
            }, 60);
        }

        function closeProductAnalytics() {
            document.getElementById('product-analytics-modal').style.display = 'none';
        }

        // ===================== PERMISSIONS =====================
        function canAccess(feature) {
            if (!user) return false;
            if (user.role === 'admin') return true;
            // Allow all staff to see staff performance, pos, and receipts
            if (['staff', 'pos', 'receipts'].includes(feature)) return true;
            if (user.role === 'inventory') return ['pos', 'inventory', 'procurement', 'receipts'].includes(feature);
            return false;
        }

        function initUI() {
            document.getElementById('user-display').innerText = `${user.name} (${user.role})`;
            document.getElementById('nav-title').innerText = db_biz.name ? db_biz.name.toUpperCase() : 'WORKSPACE';
            document.getElementById('account-balance-nav').innerText = `${db_finance.toLocaleString()}`;

            // Admin-only: Update Balance button
            document.getElementById('btn-update-balance').style.display = (user.role === 'admin') ? 'inline-block' : 'none';

            // Set staff online status
            setStaffOnlineStatus(user.id, true);

            // Show setup guide to admin if Supabase not yet configured
            if (user.role === 'admin' && !ENABLE_SUPABASE) {
                setTimeout(() => { document.getElementById('modal-setup').style.display = 'flex'; }, 1200);
            }

            const isAdmin = user.role === 'admin';
            ['icon-inv', 'icon-acc', 'icon-biz', 'icon-proc'].forEach(id => {
                const el = document.getElementById(id);
                el.style.display = (id === 'icon-acc' || id === 'icon-biz') ? (isAdmin ? 'flex' : 'none') : (canAccess(id === 'icon-inv' ? 'inventory' : 'procurement') ? 'flex' : 'none');
            });
            // Everyone can see Receipts and Staff icons
            document.getElementById('icon-receipts').style.display = 'flex';
            document.getElementById('icon-staff').style.display = 'flex';

            if(isAdmin) document.getElementById('btn-hire-staff').style.display = 'block';

            // Mobile bottom nav: show/hide items per role
            const canInv = canAccess('inventory');
            const canProc = canAccess('procurement');
            const setMobileNav = (id, show) => { const el = document.getElementById(id); if(el) el.style.display = show ? 'flex' : 'none'; };
            setMobileNav('bn-inv', canInv);
            setMobileNav('bn-proc', canProc);
            setMobileNav('bn-acc', isAdmin);
            setMobileNav('bn-biz', isAdmin);

            fillBusinessForm();
            renderPOS();
            renderInventory();
            renderProcurement();
            renderAccounting();
            renderStaff();
            renderReceipts();
            renderChat();
            if (chatInterval) clearInterval(chatInterval);
            chatInterval = setInterval(renderChat, 2000);
            // Refresh staff online status every 15s
            if (window._staffRefreshInterval) clearInterval(window._staffRefreshInterval);
            window._staffRefreshInterval = setInterval(() => {
                db_staff = JSON.parse(localStorage.getItem('v72_staff')) || db_staff;
                renderStaff();
            }, 15000);
            startPresenceHeartbeat();
            persistLocalOnly();
        }

        function fillBusinessForm() {
            document.getElementById('biz-name').value = db_biz.name || '';
            document.getElementById('biz-web').value = db_biz.website || '';
            document.getElementById('biz-phone').value = db_biz.phone || '';
            document.getElementById('biz-addr').value = db_biz.address || '';
            document.getElementById('biz-social').value = db_biz.social || '';
        }

        function persistLocalOnly() {
            localStorage.setItem('v72_biz', JSON.stringify(db_biz));
            localStorage.setItem('v72_staff', JSON.stringify(db_staff));
            localStorage.setItem('v72_inv', JSON.stringify(db_inv));
            localStorage.setItem('v72_acc', JSON.stringify(db_acc));
            localStorage.setItem('v72_purch', JSON.stringify(db_purch));
            localStorage.setItem('v72_chat', JSON.stringify(db_chat));
            localStorage.setItem('v72_sales', JSON.stringify(db_sales));
            localStorage.setItem('v72_finance', db_finance.toString());
            document.getElementById('account-balance-nav').innerText = `${db_finance.toLocaleString()}`;
        }

        async function persist() {
            persistLocalOnly();
            await cloudSave();
        }

        // ===================== GLOBAL FUNCTIONS (Fixed) =====================
        function promptUpdateBalance() {
            const val = parseFloat(prompt("Enter amount to ADD (+) or REMOVE (-):"));
            if(isNaN(val)) return alert("Invalid amount");
            db_finance += val;
            persist();
            showToast("Balance updated successfully");
        }

        document.addEventListener('keypress', function(e){
            // BUG FIX 1: Prevent scanner from intercepting normal typing in input fields
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
                return;
            }

            if(!window.barcodeBuffer) window.barcodeBuffer = "";
            
            if(e.key === 'Enter'){
                const code = window.barcodeBuffer.trim();
                window.barcodeBuffer = "";
                
                if(code) {
                    // BUG FIX 2: Force string comparison for purely numerical barcodes
                    const product = db_inv.find(p => String(p.barcode || '') === String(code));
                    if(product) {
                        addToCart(product.id, null);
                    } else {
                        showToast(`Barcode not found: ${code}`, 'warning');
                    }
                }
            } else {
                window.barcodeBuffer += e.key;
            }
        });

        // ===================== APP NAV =====================
        function switchApp(id) {
            if (!canAccess(id)) return showToast('Access denied for your role.', 'error');
            document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
            document.querySelectorAll('.app-icon').forEach(i => i.classList.remove('active'));
            document.getElementById(id).classList.add('active');

            // Desktop sidebar active state
            const mapping = { 'pos': null, 'inventory': 'icon-inv', 'procurement': 'icon-proc', 'accounting': 'icon-acc', 'staff': 'icon-staff', 'business': 'icon-biz', 'receipts': 'icon-receipts' };
            if (mapping[id]) document.getElementById(mapping[id]).classList.add('active');
            else document.querySelector('.apps-sidebar .app-icon:first-child').classList.add('active');

            // Mobile bottom nav active state
            document.querySelectorAll('.bottom-nav-item').forEach(b => b.classList.remove('active'));
            const bnMap = { 'pos': 'bn-pos', 'receipts': 'bn-receipts', 'inventory': 'bn-inv', 'procurement': 'bn-proc', 'accounting': 'bn-acc', 'staff': 'bn-staff', 'business': 'bn-biz' };
            if (bnMap[id]) { const el = document.getElementById(bnMap[id]); if (el) el.classList.add('active'); }

            if (id === 'inventory') renderInventory();
            if (id === 'procurement') renderProcurement();
            if (id === 'accounting') renderAccounting();
            if (id === 'staff') renderStaff();
            if (id === 'pos') renderPOS();
            if (id === 'receipts') renderReceipts();
        }

        // ===================== THERMAL RECEIPT PRINTING =====================
        function printThermalReceipt(inv) {
            const w = window.open('', '_blank', 'width=400,height=600');
            
            let itemsHtml = inv.items.map(i => `
                <tr>
                    <td style="padding: 3px 0;">${i.name}</td>
                    <td style="text-align: center;">${i.qty}</td>
                    <td style="text-align: right;">₦${(i.qty * i.price).toLocaleString()}</td>
                </tr>
            `).join('');

            // BUG FIX 4: Ensured window.print() only fires after the document is completely ready
            const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <title>Receipt ${inv.inv}</title>
                <style>
                    body { font-family: 'Courier New', Courier, monospace; width: 300px; margin: 0 auto; padding: 10px; color: #000; font-size: 12px; }
                    h2, h3, h4 { margin: 5px 0; text-align: center; }
                    table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px; }
                    th, td { border-bottom: 1px dashed #000; padding: 5px 0; }
                    .text-right { text-align: right; }
                    .text-center { text-align: center; }
                    .totals { margin-top: 10px; font-weight: bold; font-size: 13px; }
                    .totals div { display: flex; justify-content: space-between; margin-bottom: 4px; }
                    @media print { body { width: 100%; margin: 0; padding: 0; } }
                </style>
            </head>
            <body>
                <h2>${db_biz.name || 'Store Name'}</h2>
                <div class="text-center">${db_biz.address || ''}</div>
                <div class="text-center">${db_biz.phone || ''}</div>
                <hr style="border-top: 1px dashed #000; margin: 10px 0;">
                <div><b>Inv:</b> ${inv.inv}</div>
                <div><b>Date:</b> ${inv.date}</div>
                <div><b>Cashier:</b> ${inv.cashier}</div>
                <div><b>Customer:</b> ${inv.customer}</div>
                <div><b>Payment:</b> ${inv.paymentMethod || 'Cash'}</div>
                <table>
                    <thead><tr><th style="text-align:left;">Item</th><th>Qty</th><th style="text-align:right;">Total</th></tr></thead>
                    <tbody>${itemsHtml}</tbody>
                </table>
                <div class="totals">
                    <div><span>Subtotal:</span> <span>₦${inv.subtotal.toLocaleString()}</span></div>
                    <div><span>Discount:</span> <span>₦${inv.discount.toLocaleString()}</span></div>
                    <div style="font-size: 15px; border-top: 2px solid #000; padding-top: 5px; margin-top: 5px;"><span>TOTAL:</span> <span>₦${inv.total.toLocaleString()}</span></div>
                </div>
                <hr style="border-top: 1px dashed #000; margin: 10px 0;">
                <div class="text-center">Thank you for your business!</div>
                <script>
                    window.onload = function() { window.print(); setTimeout(function(){ window.close(); }, 500); }
                <\/script>
            </body>
            </html>
            `;
            w.document.open();
            w.document.write(html);
            w.document.close();
        }

        // ===================== POS & BARCODE =====================
        // renderPOS is defined above in the inline script block

        function renderPOS() {
            const grid = document.getElementById('pos-items');
            if (!grid) return;

            const searchEl = document.getElementById('pos-search');
            const query = searchEl ? searchEl.value.trim().toLowerCase() : '';

            const grouped = {};
            db_inv.forEach(p => {
                if (!grouped[p.name]) grouped[p.name] = [];
                grouped[p.name].push(p);
            });

            let names = Object.keys(grouped);
            if (query) names = names.filter(n => n.toLowerCase().includes(query));

            if (!names.length) {
                grid.innerHTML = `<div style="text-align:center;padding:40px;color:#7f8c8d;font-size:15px;">No products found for "<b>${escapeHtml(query)}</b>"</div>`;
                return;
            }

            // Store name->index map on window so onclick data-attr can look it up
            window._posNameMap = {};
            names.forEach((name, i) => { window._posNameMap[i] = name; });

            grid.innerHTML = names.map((name, i) => {
                const variants = grouped[name];
                const totalStock = variants.reduce((s, v) => s + (+v.stock || 0), 0);
                const minPrice = Math.min(...variants.map(v => +v.price || 0));
                const maxPrice = Math.max(...variants.map(v => +v.price || 0));
                const priceStr = minPrice === maxPrice
                    ? `&#8358;${minPrice.toLocaleString()}`
                    : `&#8358;${minPrice.toLocaleString()} &ndash; &#8358;${maxPrice.toLocaleString()}`;
                const totalSold = variants.reduce((s, v) => s + (+v.sales || 0), 0);
                const isOut = totalStock <= 0;
                const isLow = !isOut && totalStock <= 5;
                const stockClass = isOut ? 'stock-out' : isLow ? 'stock-low' : 'stock-ok';
                const stockLabel = isOut ? 'Out of Stock' : isLow ? `Low: ${totalStock}` : `${totalStock} in stock`;

                const nm = name.toLowerCase();
                const emoji = nm.includes('shoe')||nm.includes('boot')||nm.includes('sneak') ? '👟'
                    : nm.includes('shirt')||nm.includes('top')||nm.includes('tee') ? '👕'
                    : nm.includes('trouser')||nm.includes('pant')||nm.includes('jean') ? '👖'
                    : nm.includes('bag')||nm.includes('purse') ? '👜'
                    : nm.includes('phone')||nm.includes('mobile') ? '📱'
                    : nm.includes('laptop')||nm.includes('computer') ? '💻'
                    : nm.includes('watch') ? '⌚'
                    : nm.includes('dress') ? '👗'
                    : nm.includes('cap')||nm.includes('hat') ? '🧢'
                    : nm.includes('juice')||nm.includes('drink')||nm.includes('water') ? '🥤'
                    : nm.includes('food')||nm.includes('rice')||nm.includes('snack') ? '🍱'
                    : '📦';

                const variantMeta = variants.length > 1
                    ? variants.map(v => [v.style, v.color, v.size !== 'N/A' ? v.size : ''].filter(Boolean).join('/')).filter(Boolean).join(', ')
                    : [variants[0].style, variants[0].color, variants[0].size !== 'N/A' ? variants[0].size : ''].filter(Boolean).join(' · ');

                // Use data-idx to avoid any quote escaping issues in onclick
                return `
                <div class="pos-item ${isOut ? 'out-of-stock' : ''}" data-pidx="${i}" onclick="posItemClick(this)">
                    <div class="pos-item-emoji">${emoji}</div>
                    <div class="pos-item-body">
                        <div class="pos-item-name">${escapeHtml(name)}</div>
                        <div class="pos-item-meta">${escapeHtml(variantMeta) || (variants.length + ' variant' + (variants.length > 1 ? 's' : ''))}</div>
                        ${totalSold > 0 ? `<div style="font-size:11px;color:#9b59b6;margin-top:2px;">&#128293; ${totalSold} sold</div>` : ''}
                    </div>
                    <div class="pos-item-right">
                        <div class="pos-item-price">${priceStr}</div>
                        <span class="pos-item-stock ${stockClass}">${stockLabel}</span>
                        <div class="pos-item-actions">
                            <button style="background:var(--odoo-teal);color:white;" onclick="event.stopPropagation();posItemClick(this.closest('.pos-item'))">+ Add</button>
                            <button style="background:var(--odoo-purple);color:white;" onclick="event.stopPropagation();posAnalyticsClick(this.closest('.pos-item'))">&#128202;</button>
                        </div>
                    </div>
                </div>`;
            }).join('');
        }

        function posItemClick(el) {
            const idx = parseInt(el.getAttribute('data-pidx'), 10);
            const name = window._posNameMap && window._posNameMap[idx];
            if (!name) return;
            selectVariant(name);
        }

        function posAnalyticsClick(el) {
            const idx = parseInt(el.getAttribute('data-pidx'), 10);
            const name = window._posNameMap && window._posNameMap[idx];
            if (!name) return;
            viewVariantAnalytics(name);
        }

        function selectVariant(productName) {
            const variants = db_inv.filter(p => p.name === productName);
            if (!variants.length) return;
            if (variants.length === 1) { addToCart(variants[0].id, null); return; }

            const container = document.getElementById('variant-options');
            container.innerHTML = variants.map(v => {
                const isOut = v.stock <= 0;
                const label = [v.style, v.color, v.size !== 'N/A' ? v.size : ''].filter(Boolean).join(' · ') || 'Default';
                return `
                <div data-vid="${v.id}" data-out="${isOut ? '1' : '0'}" onclick="variantRowClick(this)"
                     style="border:1.5px solid ${isOut ? '#f8d7da' : '#e1e4e8'};padding:12px 14px;margin-bottom:8px;border-radius:10px;cursor:${isOut ? 'not-allowed' : 'pointer'};opacity:${isOut ? '0.5' : '1'};display:flex;justify-content:space-between;align-items:center;">
                    <div>
                        <div style="font-size:15px;font-weight:700;color:var(--text-dark);">${escapeHtml(label)}</div>
                        <div style="font-size:12px;color:#7f8c8d;margin-top:3px;">${isOut ? '&#10060; Out of stock' : v.stock + ' available'}</div>
                    </div>
                    <div style="font-size:17px;font-weight:800;color:var(--odoo-teal);">&#8358;${(+v.price).toLocaleString()}</div>
                </div>`;
            }).join('');
            document.getElementById('variant-modal').style.display = 'flex';
        }

        function variantRowClick(el) {
            if (el.getAttribute('data-out') === '1') return;
            const id = parseInt(el.getAttribute('data-vid'), 10);
            closeVariantModal();
            addToCart(id, null);
        }

        function addVariantToCart(id) { closeVariantModal(); addToCart(id, null); }
        function closeVariantModal() { document.getElementById('variant-modal').style.display = 'none'; }

        function addToCart(id, qtyOverride = null) {
            const p = db_inv.find(x => x.id == id);
            if (!p) return showToast('Product not found.', 'error');
            if (p.stock <= 0) return showToast('Item is completely out of stock!', 'error');
            const qty = Math.max(1, parseInt(qtyOverride || document.getElementById('pos-qty').value || '1', 10) || 1);
            const existing = cart.find(x => x.id == id);
            const totalQty = (existing ? existing.qty : 0) + qty;
            if (totalQty > p.stock) return showToast(`Cannot exceed available stock of ${p.stock}`, 'warning');
            if (existing) existing.qty = totalQty; else cart.push({ id: p.id, qty });
            calculateTotal();
        }

        function updateCartQty(idx, newQty) {
            const val = parseInt(newQty, 10);
            const cartItem = cart[idx];
            const p = db_inv.find(x => x.id == cartItem.id);
            if (!p) return;
            if (isNaN(val) || val < 1) { removeFromCart(idx); return; }
            if (val > p.stock) {
                showToast(`Cannot exceed available stock of ${p.stock}`, 'warning');
                document.getElementById(`qty-${idx}`).value = cartItem.qty;
                return;
            }
            cart[idx].qty = val;
            calculateTotal();
        }

        function removeFromCart(idx) { cart.splice(idx, 1); calculateTotal(); }
        function clearCart() { cart = []; calculateTotal(); }

        function calculateTotal() {
            const list = document.getElementById('cart-list');
            let subtotal = 0;
            list.innerHTML = cart.map((cItem, idx) => {
                const p = db_inv.find(x => x.id == cItem.id);
                if (!p) return '';
                const lineTotal = p.price * cItem.qty;
                subtotal += lineTotal;
                return `
                    <div class="cart-item">
                        <div><b>${escapeHtml(p.name)}</b><br><small>₦${(+p.price).toLocaleString()} each</small></div>
                        <input type="number" id="qty-${idx}" class="cart-qty-input" value="${cItem.qty}" min="1" max="${p.stock}" onchange="updateCartQty(${idx}, this.value)">
                        <div style="text-align:right; font-weight:bold;">₦${lineTotal.toLocaleString()}</div>
                        <button class="btn-odoo btn-danger" style="padding:4px 8px; border-radius:4px;" onclick="removeFromCart(${idx})">✖</button>
                    </div>
                `;
            }).join('');
            const discount = Math.max(0, parseFloat(document.getElementById('pos-discount').value) || 0);
            const final = Math.max(0, subtotal - discount);
            document.getElementById('sub-val').innerText = '₦' + subtotal.toLocaleString();
            document.getElementById('total-price').innerText = '₦' + final.toLocaleString();
        }

        function openPaymentModal() {
            if (!cart.length) return showToast('Cart is empty!', 'warning');
            const disc = Math.max(0, parseFloat(document.getElementById('pos-discount').value) || 0);
            let subtotal = 0;
            for (const cItem of cart) {
                const p = db_inv.find(x => x.id == cItem.id);
                if (p) subtotal += p.price * cItem.qty;
            }
            const finalTotal = Math.max(0, subtotal - disc);
            document.getElementById('pay-total-display').innerText = '₦' + finalTotal.toLocaleString();
            document.getElementById('modal-payment').style.display = 'flex';
        }

        function closePaymentModal() {
            document.getElementById('modal-payment').style.display = 'none';
        }

        async function processCheckout(paymentMethod) {
            closePaymentModal();
            if (!cart.length) return showToast('Cart is empty!', 'warning');
            const cust = document.getElementById('cust-name').value.trim() || 'Walk-in Customer';
            const disc = Math.max(0, parseFloat(document.getElementById('pos-discount').value) || 0);
            const saleItems = cart.map(c => ({ ...c }));
            let subtotal = 0; let totalCost = 0;

            for (const cItem of saleItems) {
                const stockItem = db_inv.find(x => x.id == cItem.id);
                if (!stockItem) return showToast('Item removed from inventory.', 'error');
                if (stockItem.stock < cItem.qty) return showToast(`Failed: ${stockItem.name} has only ${stockItem.stock} left.`, 'error');
                subtotal += stockItem.price * cItem.qty;
                totalCost += stockItem.cost * cItem.qty;
            }

            const finalTotal = Math.max(0, subtotal - disc);
            const profit = finalTotal - totalCost;
            const invNum = 'INV-' + Date.now().toString().slice(-6);
            const cashier = user ? user.name : 'System';
            const timestamp = Date.now();
            const receiptDateTime = new Date(timestamp).toLocaleString('en-NG', { dateStyle: 'full', timeStyle: 'medium' });

            // Deduct stock
            saleItems.forEach(c => {
                const idx = db_inv.findIndex(x => x.id == c.id);
                if (idx > -1) { db_inv[idx].stock -= c.qty; db_inv[idx].sales = (db_inv[idx].sales || 0) + c.qty; }
            });

            currentInvoice = {
                inv: invNum, customer: cust, cashier, timestamp, paymentMethod,
                date: receiptDateTime,
                items: saleItems.map(c => {
                    const p = db_inv.find(x => x.id == c.id);
                    return { id: c.id, name: p ? p.name : 'Item', qty: c.qty, price: p ? p.price : 0, cost: p ? p.cost : 0 };
                }),
                subtotal, discount: disc, total: finalTotal, profit
            };

            db_acc.push({ inv: invNum, customer: cust, cashier, timestamp, date: new Date(timestamp).toLocaleDateString(), total: finalTotal, profit, cost: totalCost, paymentMethod });
            db_sales.push({ inv: invNum, customer: cust, cashier, timestamp, date: new Date(timestamp).toLocaleDateString(), total: finalTotal, profit, cost: totalCost, paymentMethod, items: saleItems.map(c => ({ id: c.id, qty: c.qty })) });
            db_finance += finalTotal;

            const sIdx = db_staff.findIndex(x => x.id == user.id);
            if (sIdx > -1) db_staff[sIdx].salesCount = (db_staff[sIdx].salesCount || 0) + 1;

            persist();

            // Auto-clear basket immediately
            cart = [];
            document.getElementById('cust-name').value = '';
            document.getElementById('pos-discount').value = '0';
            calculateTotal();

            // Re-render other tabs
            renderPOS(); renderAccounting(); renderStaff(); renderReceipts();

            // Show receipt immediately
            printThermalReceipt(currentInvoice);
            showToast(`✅ ${paymentMethod} payment recorded — receipt printing!`, 'success');
            stopScanner();
        }

        // ===================== RECEIPTS & INVOICES =====================
        function renderReceipts() {
            const tbody = document.getElementById('receipts-table');
            if(!tbody) return;
            const isAdmin = user && user.role === 'admin';
            // Non-admin staff only see their own sales
            const visibleSales = isAdmin ? db_sales : db_sales.filter(s => s.cashier === user.name);
            const receiptsHeader = document.getElementById('receipts-header-info');
            if (receiptsHeader) {
                receiptsHeader.innerText = isAdmin ? 'View all transactions across all staff.' : `Showing your sales only (${user.name}).`;
            }
            tbody.innerHTML = visibleSales.slice().reverse().map(s => `
                <tr>
                    <td style="font-family:monospace;">${s.inv}</td>
                    <td>${s.date}</td>
                    <td>${escapeHtml(s.customer)}</td>
                    <td>${escapeHtml(s.cashier)}</td>
                    <td style="font-weight:bold; color:var(--odoo-teal);">₦${s.total.toLocaleString()}</td>
                    <td><button class="btn-odoo btn-teal" style="padding:6px 12px; font-size:12px;" onclick="reprintReceipt('${s.inv}')">Print Receipt</button></td>
                </tr>
            `).join('');
        }

        function reprintReceipt(invNo) {
            const sale = db_sales.find(x => x.inv === invNo);
            if(sale) {
                const fullSale = {...sale};
                fullSale.items = sale.items.map(it => {
                    const p = db_inv.find(x => x.id == it.id);
                    return { id: it.id, name: p ? p.name : 'Item', qty: it.qty, price: p ? p.price : 0, cost: p ? p.cost : 0 };
                });
                const subtotal = fullSale.items.reduce((sum, i) => sum + (i.qty * i.price), 0);
                fullSale.subtotal = sale.subtotal || subtotal;
                fullSale.discount = sale.discount || Math.max(0, subtotal - sale.total);
                printThermalReceipt(fullSale);
            } else {
                showToast('Invoice not found', 'error');
            }
        }

        // ===================== INVENTORY =====================
        function openProductModal(id = null) {
            document.getElementById('prod-modal-title').innerText = id ? 'Edit Product' : 'Product Entry';
            document.getElementById('p-edit-id').value = id || '';
            if (id) {
                const p = db_inv.find(x => x.id == id);
                if (!p) return;
                document.getElementById('p-name').value = p.name || ''; document.getElementById('p-style').value = p.style || '';
                document.getElementById('p-color').value = p.color || ''; document.getElementById('p-size').value = p.size || 'N/A';
                document.getElementById('p-barcode').value = p.barcode || ''; document.getElementById('p-cost').value = p.cost || 0;
                document.getElementById('p-price').value = p.price || 0; document.getElementById('p-stock').value = p.stock || 0;
            } else {
                ['p-name','p-style','p-color','p-barcode','p-cost','p-price','p-stock'].forEach(i => document.getElementById(i).value = '');
                document.getElementById('p-size').value = 'N/A';
            }
            document.getElementById('modal-prod').style.display = 'flex';
        }

        function saveProduct() {
            const id = document.getElementById('p-edit-id').value;
            const data = {
                name: document.getElementById('p-name').value.trim(), style: document.getElementById('p-style').value.trim(),
                color: document.getElementById('p-color').value.trim(), size: document.getElementById('p-size').value,
                barcode: document.getElementById('p-barcode').value.trim(), cost: parseFloat(document.getElementById('p-cost').value) || 0,
                price: parseFloat(document.getElementById('p-price').value) || 0, stock: parseInt(document.getElementById('p-stock').value, 10) || 0, sales: 0
            };
            if (!data.name) return showToast('Name required', 'error');
            if (data.price < data.cost) showToast('Sale price is below cost price; margin will be negative.', 'warning');
            if (id) {
                const idx = db_inv.findIndex(x => x.id == id);
                db_inv[idx] = { ...db_inv[idx], ...data, sales: db_inv[idx].sales || 0 };
            } else { db_inv.push({ id: Date.now(), ...data, sales: 0 }); }
            persist(); renderInventory(); renderPOS(); renderProcurement(); closeModals(); showToast('Product saved!');
        }

        function delProd(id) {
            showConfirm('Delete this product?', () => { db_inv = db_inv.filter(x => x.id !== id); persist(); renderInventory(); renderPOS(); renderProcurement(); showToast('Product deleted.'); });
        }

        function renderInventory() {
            const body = document.getElementById('inventory-table');
            if (!body) return;
            body.innerHTML = db_inv.map(p => {
                const cost = +p.cost || 0; const price = +p.price || 0;
                const margin = price > 0 ? ((price - cost) / price) * 100 : 0;
                const marginClass = margin >= 20 ? 'margin-good' : 'margin-low';
                return `<tr>
                    <td><b>${escapeHtml(p.name)}</b></td>
                    <td>${escapeHtml(p.style || '-')} | ${escapeHtml(p.color || '-')} | Size: ${escapeHtml(p.size || 'N/A')}</td>
                    <td style="font-family:monospace;">${escapeHtml(p.barcode || '-')}</td>
                    <td style="color:#c0392b; font-weight:bold;">₦${cost.toLocaleString()}</td>
                    <td style="color:var(--odoo-teal); font-weight:bold;">₦${price.toLocaleString()}</td>
                    <td class="${marginClass}">${margin.toFixed(1)}%</td>
                    <td><span class="badge ${p.stock > 5 ? 'badge-active' : 'badge-deleted'}">${p.stock}</span></td>
                    <td>
                        <button class="btn-odoo" style="padding:6px 12px; font-size:12px;" onclick="openProductModal(${p.id})">Edit</button>
                        <button class="btn-odoo btn-danger" style="padding:6px 12px; font-size:12px;" onclick="delProd(${p.id})">Del</button>
                    </td>
                </tr>`;
            }).join('');
        }

        // ===================== PROCUREMENT =====================
        function renderProcurement() {
            const sel = document.getElementById('buy-prod-id');
            if (!sel) return;
            sel.innerHTML = db_inv.length ? db_inv.map(p => `<option value="${p.id}">${escapeHtml(p.name)} (${escapeHtml(p.style || 'No style')})</option>`).join('') : `<option value="">No products yet</option>`;
            document.getElementById('purchase-history-table').innerHTML = db_purch.slice().reverse().map(h => `<tr><td>${h.date}</td><td>${escapeHtml(h.name)}</td><td>${h.qty}</td><td>₦${h.unitCost.toLocaleString()}</td><td style="color:#e74c3c; font-weight:bold;">-₦${(h.qty * h.unitCost).toLocaleString()}</td></tr>`).join('');
        }

        function processPurchase() {
            const pid = document.getElementById('buy-prod-id').value;
            const qty = parseInt(document.getElementById('buy-qty').value, 10);
            const cost = parseFloat(document.getElementById('buy-cost').value);
            if (!pid || !qty || !cost) return showToast('Fill all fields', 'error');
            const totalCost = qty * cost;
            if (totalCost > db_finance) return showToast('Insufficient Balance!', 'error');
            const pIdx = db_inv.findIndex(x => x.id == pid);
            if (pIdx < 0) return showToast('Product not found.', 'error');
            db_finance -= totalCost; db_inv[pIdx].stock += qty; db_inv[pIdx].cost = cost;
            db_purch.push({ date: new Date().toLocaleDateString(), name: db_inv[pIdx].name, qty, unitCost: cost, timestamp: Date.now() });
            persist(); renderProcurement(); renderInventory(); renderPOS(); renderAccounting(); showToast(`Restocked ${qty} items.`);
        }

        // ===================== ACCOUNTING / ANALYTICS =====================
        function printReport() {
            const data = filterAccounting();
            let text = `FINANCIAL REPORT - ${new Date().toLocaleDateString()}\n------------------------------------\n`;
            let rTotal = 0;
            data.forEach(d=>{ text += `${d.date} - ${d.inv} - ₦${d.total}\n`; rTotal += d.total; });
            text += `\nTOTAL REVENUE: ₦${rTotal.toLocaleString()}`;
            const w = window.open('', '_blank', 'width=600,height=600');
            w.document.write("<pre>"+text+"</pre><script>window.onload=function(){window.print();}<\/script>");
            w.document.close();
        }

        function filterAccounting() {
            const filter = document.getElementById('report-filter').value;
            const now = Date.now();
            let filteredAcc = db_acc.slice();
            if (filter !== 'all') {
                const msPerDay = 86400000;
                let limit = 0;
                if (filter === 'daily') limit = msPerDay; if (filter === 'weekly') limit = msPerDay * 7; if (filter === 'monthly') limit = msPerDay * 30;
                filteredAcc = db_acc.filter(a => (now - a.timestamp) <= limit);
            }
            return filteredAcc;
        }

        function renderAccounting() {
            const filteredAcc = filterAccounting();
            const ledger = document.getElementById('accounting-table');
            if (ledger) {
                ledger.innerHTML = filteredAcc.slice().reverse().map(a => `<tr><td style="font-family:monospace;">${a.inv}</td><td>${escapeHtml(a.customer)}</td><td>${escapeHtml(a.cashier)}</td><td>${new Date(a.timestamp).toLocaleString()}</td><td style="font-weight:bold; color:var(--odoo-teal);">₦${a.total.toLocaleString()}</td><td style="font-weight:bold; color:${a.profit >= 0 ? '#27ae60' : '#c0392b'};">₦${a.profit.toLocaleString()}</td><td><button class="btn-odoo" style="padding:6px 10px; font-size:12px;" onclick="reprintReceipt('${a.inv}')">Print</button></td></tr>`).join('');
            }

            const rev = filteredAcc.reduce((sum, a) => sum + (+a.total || 0), 0);
            const costs = db_purch.reduce((sum, p) => sum + (p.qty * p.unitCost), 0);
            const profit = filteredAcc.reduce((sum, a) => sum + (+a.profit || 0), 0) - costs * 0;
            const storeVal = db_inv.reduce((sum, p) => sum + ((+p.price || 0) * Math.max(0, +p.stock || 0)), 0);
            const topItem = db_inv.reduce((best, p) => ((+p.sales || 0) > best.sales ? { name: p.name, sales: +p.sales || 0 } : best), { name: 'N/A', sales: 0 });
            const prediction = predictProfitNextPeriod();

            document.getElementById('metric-rev').innerText = `₦${rev.toLocaleString()}`; document.getElementById('metric-cost').innerText = `₦${costs.toLocaleString()}`; document.getElementById('metric-profit').innerText = `₦${profit.toLocaleString()}`; document.getElementById('metric-val').innerText = `₦${storeVal.toLocaleString()}`; document.getElementById('metric-pred').innerText = `₦${Math.round(prediction.value).toLocaleString()}`;
            document.getElementById('metric-rev-small').innerText = `${filteredAcc.length} transactions`; document.getElementById('metric-cost-small').innerText = `${db_purch.length} purchases`; document.getElementById('metric-profit-small').innerText = prediction.trend; document.getElementById('metric-val-small').innerText = `Top item: ${topItem.name} (${topItem.sales})`; document.getElementById('metric-pred-small').innerText = prediction.explainer;

            renderCharts(filteredAcc);
            renderVariantAnalyticsTable();
        }

        function groupDaily(records, valueKey) {
            const m = new Map();
            records.forEach(r => { const d = new Date(r.timestamp); const k = d.toLocaleDateString(); m.set(k, (m.get(k) || 0) + (+r[valueKey] || 0)); });
            return [...m.entries()];
        }

        function predictProfitNextPeriod() {
            const series = groupDaily(db_acc, 'profit');
            if (series.length < 2) return { value: 0, trend: 'Not enough data', explainer: 'Need 2 days minimum.' };
            const y = series.map(([, v]) => v); const x = series.map((_, i) => i + 1);
            const n = x.length; const sumX = x.reduce((a, b) => a + b, 0); const sumY = y.reduce((a, b) => a + b, 0);
            const sumXY = x.reduce((a, xi, i) => a + xi * y[i], 0); const sumXX = x.reduce((a, xi) => a + xi * xi, 0);
            const denom = (n * sumXX - sumX * sumX) || 1; const slope = (n * sumXY - sumX * sumY) / denom;
            const intercept = (sumY - slope * sumX) / n; const next = slope * (n + 1) + intercept;
            return { value: Math.max(0, next), trend: slope >= 0 ? 'Trend: rising' : 'Trend: slowing', explainer: `Forecast based on ${series.length} points.` };
        }

        function renderCharts(filteredAcc = filterAccounting()) {
            const daily = groupDaily(filteredAcc, 'total');
            const dailyProfit = groupDaily(filteredAcc, 'profit');
            const topMap = {};
            db_sales.forEach(s => { (s.items || []).forEach(it => { const p = db_inv.find(x => x.id == it.id); const name = p ? p.name : `#${it.id}`; topMap[name] = (topMap[name] || 0) + (+it.qty || 0); }); });

            const salesCtx = document.getElementById('salesChart'); const topCtx = document.getElementById('topChart'); const profitCtx = document.getElementById('profitChart');
            if (!salesCtx || !topCtx || !profitCtx) return;
            if (charts.sales) charts.sales.destroy(); if (charts.top) charts.top.destroy(); if (charts.profit) charts.profit.destroy();

            charts.sales = new Chart(salesCtx, { type: 'line', data: { labels: daily.map(x => x[0]), datasets: [{ label: 'Revenue', data: daily.map(x => x[1]), borderColor: '#00A09D', tension: 0.25 }] }, options: { responsive: true, maintainAspectRatio: false } });
            charts.top = new Chart(topCtx, { type: 'bar', data: { labels: Object.keys(topMap), datasets: [{ label: 'Units Sold', data: Object.values(topMap), backgroundColor: '#714B67' }] }, options: { responsive: true, maintainAspectRatio: false } });
            charts.profit = new Chart(profitCtx, { type: 'bar', data: { labels: dailyProfit.map(x => x[0]), datasets: [{ label: 'Profit', data: dailyProfit.map(x => x[1]), backgroundColor: '#27ae60' }] }, options: { responsive: true, maintainAspectRatio: false } });
        }

        // ===================== STAFF & PERFORMANCE =====================
        function openStaffModal(id = null) {
            document.getElementById('s-name').value = ''; document.getElementById('s-pin').value = ''; document.getElementById('s-email').value = ''; document.getElementById('s-phone').value = ''; document.getElementById('s-unit').value = ''; document.getElementById('s-role').value = 'staff'; document.getElementById('s-status').style.display = 'none'; document.getElementById('s-edit-id').value = ''; document.getElementById('staff-modal-title').innerText = 'Staff Registration';

            if (id) {
                const s = db_staff.find(x => x.id === id);
                if (!s) return;
                document.getElementById('staff-modal-title').innerText = 'Edit Staff';
                document.getElementById('s-edit-id').value = s.id; document.getElementById('s-name').value = s.name; document.getElementById('s-email').value = s.email; document.getElementById('s-phone').value = s.phone; document.getElementById('s-unit').value = s.unit; document.getElementById('s-pin').value = s.pin; document.getElementById('s-role').value = s.role;
                if (s.id !== 1) { document.getElementById('s-status').style.display = 'block'; document.getElementById('s-status').value = s.status; }
            }
            document.getElementById('modal-staff').style.display = 'flex';
        }

        function saveStaff() {
            const editId = document.getElementById('s-edit-id').value;
            const statusVal = document.getElementById('s-status').style.display !== 'none' ? document.getElementById('s-status').value : 'active';
            const name = document.getElementById('s-name').value.trim(); const pin = document.getElementById('s-pin').value.trim();
            if (!name || !pin) return showToast('Name and PIN required.', 'error');
            const payload = { name, email: document.getElementById('s-email').value.trim(), phone: document.getElementById('s-phone').value.trim(), unit: document.getElementById('s-unit').value.trim(), pin, role: document.getElementById('s-role').value, status: statusVal, salesCount: 0 };

            if (editId) { const idx = db_staff.findIndex(x => x.id == editId); if (idx === 0) payload.status = 'active'; db_staff[idx] = { ...db_staff[idx], ...payload, salesCount: db_staff[idx].salesCount || 0 }; } else { const newStaff = { id: Date.now(), ...payload }; db_staff.push(newStaff); if (newStaff.email) sendStaffWelcomeEmail(newStaff); }
            persist(); renderStaff(); closeModals(); showToast('Staff updated.');
        }

        function toggleSuspend(id) {
            const idx = db_staff.findIndex(s => s.id === id);
            if (idx === -1 || idx === 0) return;
            db_staff[idx].status = db_staff[idx].status === 'suspended' ? 'active' : 'suspended';
            persist();
            renderStaff();
            // If the suspended staff is currently logged in on this device
            if (user && user.id === id && db_staff[idx].status !== 'active') {
                showToast('Your account has been suspended. Logging out…', 'error');
                setTimeout(() => { setStaffOnlineStatus(user.id, false); location.reload(); }, 2500);
            }
        }
        function softDeleteStaff(id) {
            showConfirm('Soft delete this staff member?', () => {
                const idx = db_staff.findIndex(x => x.id === id);
                if (idx > -1 && idx !== 0) {
                    db_staff[idx].status = 'deleted';
                    persist();
                    renderStaff();
                    showToast('Staff deleted.');
                    if (user && user.id === id) {
                        showToast('Your account was deleted. Logging out…', 'error');
                        setTimeout(() => { setStaffOnlineStatus(user.id, false); location.reload(); }, 2500);
                    }
                }
            });
        }

        function renderStaff() {
            const body = document.getElementById('staff-table');
            const head = document.getElementById('staff-table-head');
            if (!body) return;

            const isAdmin = user && user.role === 'admin';
            
            if (head) {
                head.innerHTML = `<tr><th>Name</th><th>Role</th><th>Status</th><th>Online</th><th>Access</th><th>Sales Made</th><th>Revenue Generated</th>${isAdmin ? '<th>Action</th>' : ''}</tr>`;
            }

            body.innerHTML = db_staff.map(s => {
                const badge = s.status === 'active' ? 'badge-active' : (s.status === 'deleted' ? 'badge-deleted' : 'badge-suspended');
                const access = s.role === 'admin' ? 'All ERP modules' : s.role === 'inventory' ? 'POS + Inventory + Purchases' : 'POS only';
                
                // Online/offline
                const isOnline = !!s.online;
                const lastSeenStr = s.lastSeen ? `Last seen: ${new Date(s.lastSeen).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}` : 'Never';
                const onlineHtml = `<span class="status-dot ${isOnline ? 'status-online' : 'status-offline'}"></span>${isOnline ? '<span class="online-tag">Online</span>' : `<span class="offline-tag">Offline</span><br><small style="color:#aaa;">${lastSeenStr}</small>`}`;

                // Calculate Staff Performance
                const staffSales = db_sales.filter(sale => sale.cashier === s.name);
                const salesCount = staffSales.length;
                const totalRevenue = staffSales.reduce((sum, sale) => sum + sale.total, 0);

                let actionHtml = '';
                if (isAdmin) {
                    actionHtml = `<td>
                        <button class="btn-odoo" style="padding:5px 10px; font-size:11px;" onclick="openStaffModal(${s.id})">Edit</button>
                        ${s.id !== 1 && s.status !== 'deleted' ? `<button class="btn-odoo" style="padding:5px 10px; font-size:11px; background:#f39c12;" onclick="toggleSuspend(${s.id})">${s.status === 'suspended' ? 'Activate' : 'Suspend'}</button>` : ''}
                        ${s.id !== 1 && s.status !== 'deleted' ? `<button class="btn-odoo btn-danger" style="padding:5px 10px; font-size:11px;" onclick="softDeleteStaff(${s.id})">Del</button>` : ''}
                    </td>`;
                }

                return `
                    <tr style="${s.status === 'deleted' ? 'opacity:0.6;' : ''}">
                        <td><b>${escapeHtml(s.name)}</b><br><small style="color:#7f8c8d;">PIN: ***${String(s.pin || '').slice(-1)} | ${escapeHtml(s.phone || '')}</small></td>
                        <td>${String(s.role || '').toUpperCase()}<br><small>${escapeHtml(s.unit || '')}</small></td>
                        <td><span class="badge ${badge}">${s.status}</span></td>
                        <td>${onlineHtml}</td>
                        <td>${access}</td>
                        <td style="font-weight:bold;">${salesCount} transactions</td>
                        <td style="font-weight:bold; color:var(--odoo-teal);">₦${totalRevenue.toLocaleString()}</td>
                        ${actionHtml}
                    </tr>
                `;
            }).join('');
        }

        // ===================== CHAT =====================
        function toggleChat() { 
            const panel = document.getElementById('chat-panel'); 
            panel.style.display = panel.style.display === 'flex' ? 'none' : 'flex'; 
            document.getElementById('chat-badge').style.display = 'none'; 
            const fabBadge = document.getElementById('chat-badge-fab');
            if (fabBadge) fabBadge.style.display = 'none';
            if (panel.style.display === 'flex') scrollToChatBottom(); 
        }
        async function sendChat() { 
            const input = document.getElementById('chat-input'); 
            if (!input.value.trim()) return; 
            const msg = { 
                id: Date.now(), 
                sender: user.name, 
                senderId: user.id, 
                msg: input.value.trim(), 
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                senderOnline: true
            };
            input.value = '';
            if (supabaseReady) {
                // Firestore chat: each message is its own doc, real-time listener picks it up
                await cloudSendChat(msg);
            } else {
                db_chat.push(msg);
                persist();
                renderChat();
            }
            scrollToChatBottom(); 
        }
        function renderChat() { 
            if (db_chat.length > lastChatLen) { 
                const panelVisible = document.getElementById('chat-panel').style.display === 'flex'; 
                const last = db_chat[db_chat.length - 1]; 
                if (!panelVisible && last && last.sender !== user.name) {
                    document.getElementById('chat-badge').style.display = 'inline';
                    const fabBadge = document.getElementById('chat-badge-fab');
                    if (fabBadge) { fabBadge.style.display = 'flex'; }
                }
                lastChatLen = db_chat.length; 
            } 
            // Update online staff list in chat header
            const onlineList = document.getElementById('chat-online-list');
            if (onlineList) {
                const onlineStaff = db_staff.filter(s => s.online && s.status === 'active');
                onlineList.innerHTML = onlineStaff.length ? onlineStaff.map(s => `<span class="status-dot status-online"></span>${escapeHtml(s.name)}`).join(' &nbsp; ') : 'No one online';
            }
            const box = document.getElementById('chat-box'); 
            box.innerHTML = db_chat.slice(-50).map(c => {
                const isMine = c.sender === user.name;
                const senderStaff = db_staff.find(x => x.id === c.senderId || x.name === c.sender);
                const senderOnline = senderStaff ? !!senderStaff.online : false;
                const onlineDot = `<span class="status-dot ${senderOnline ? 'status-online' : 'status-offline'}" style="width:7px;height:7px;margin-right:3px;"></span>`;
                return `<div class="chat-msg ${isMine ? 'msg-mine' : 'msg-other'}">
                    <span style="font-size:10px; font-weight:bold; display:block; margin-bottom:3px; opacity:0.8;">
                        ${onlineDot}${isMine ? 'You' : escapeHtml(c.sender)} • ${c.time}
                    </span>
                    ${escapeHtml(c.msg)}
                </div>`;
            }).join(''); 
        }
        function scrollToChatBottom() { const box = document.getElementById('chat-box'); box.scrollTop = box.scrollHeight; }

        // ===================== SCANNER =====================
        function startScanner() {
            if (!canAccess('pos')) return showToast('Access denied.', 'error');
            if (scannerRunning) return;
            const overlay = document.getElementById('scanner-overlay'); overlay.style.display = 'flex'; scannerRunning = true;
            try { Quagga.init({ inputStream: { type: 'LiveStream', target: document.querySelector('#scanner-view'), constraints: { facingMode: 'environment' } }, locator: { patchSize: 'medium', halfSample: true }, numOfWorkers: navigator.hardwareConcurrency || 2, frequency: 10, decoder: { readers: ['code_128_reader', 'ean_reader', 'ean_8_reader', 'upc_reader'] }, locate: true }, function(err) { if (err) { scannerRunning = false; overlay.style.display = 'none'; return showToast('Scanner error.', 'error'); } Quagga.start(); }); Quagga.offDetected(onBarcodeDetected); Quagga.onDetected(onBarcodeDetected); } catch (e) { scannerRunning = false; overlay.style.display = 'none'; showToast('Scanner failed.', 'error'); }
        }
        function onBarcodeDetected(data) { const code = data?.codeResult?.code; if (!code) return; const p = db_inv.find(x => String(x.barcode || '') === String(code)); if (p) { addToCart(p.id, null); showToast(`Scanned: ${p.name}`); stopScanner(); } else { showToast(`Barcode not found: ${code}`, 'warning'); } }
        function stopScanner() { document.getElementById('scanner-overlay').style.display = 'none'; if (scannerRunning) { try { Quagga.stop(); } catch (e) {} } scannerRunning = false; }

        // ===================== BUSINESS =====================
        function saveBusinessInfo() { db_biz = { name: document.getElementById('biz-name').value.trim(), website: document.getElementById('biz-web').value.trim(), phone: document.getElementById('biz-phone').value.trim(), address: document.getElementById('biz-addr').value.trim(), social: document.getElementById('biz-social').value.trim() }; if (!db_biz.name) return showToast('Business name is required.', 'error'); persist(); fillBusinessForm(); document.getElementById('nav-title').innerText = db_biz.name.toUpperCase(); showToast('Profile Updated!'); }
        function masterWipe() { if (document.getElementById('wipe-code').value === '147258') { if (confirm('CRITICAL: This will delete ALL sales, inventory, and purchases. Proceed?')) { localStorage.clear(); location.reload(); } } else { showToast('Incorrect Code', 'error'); } }
        function closeModals() { document.querySelectorAll('[id^="modal-"]').forEach(m => m.style.display = 'none'); }
        function logout() { 
            if (user) setStaffOnlineStatus(user.id, false);
            location.reload(); 
        }
        function escapeHtml(str) { return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

        // ===================== LIVE CLOCK =====================
        function startLiveClock() {
            function tick() {
                const now = new Date();
                const dateStr = now.toLocaleDateString('en-NG', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
                const timeStr = now.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
                const d = document.getElementById('live-date');
                const t = document.getElementById('live-time');
                const z = document.getElementById('live-tz');
                if (d) d.textContent = dateStr;
                if (t) t.textContent = timeStr;
                if (z) z.textContent = tz;
            }
            tick();
            setInterval(tick, 1000);
        }

        // ===================== VARIANT ANALYTICS TABLE (in Accounting) =====================
        function renderVariantAnalyticsTable() {
            const body = document.getElementById('variant-analytics-body');
            if (!body) return;
            const search = (document.getElementById('variant-analytics-search') || {}).value || '';
            const q = search.trim().toLowerCase();

            // Group products by name
            const grouped = {};
            db_inv.forEach(p => {
                if (!grouped[p.name]) grouped[p.name] = [];
                grouped[p.name].push(p);
            });

            // Build variant sales map from actual db_sales
            const variantSalesMap = {};
            db_inv.forEach(v => { variantSalesMap[v.id] = { units: 0, revenue: 0, profit: 0 }; });
            db_sales.forEach(sale => {
                (sale.items || []).forEach(it => {
                    if (variantSalesMap[it.id] !== undefined) {
                        const v = db_inv.find(x => x.id == it.id);
                        if (!v) return;
                        variantSalesMap[it.id].units += +it.qty || 0;
                        variantSalesMap[it.id].revenue += (+it.qty || 0) * (+v.price || 0);
                        variantSalesMap[it.id].profit += (+it.qty || 0) * ((+v.price || 0) - (+v.cost || 0));
                    }
                });
            });

            let rows = [];
            Object.keys(grouped).forEach(name => {
                if (q && !name.toLowerCase().includes(q)) return;
                grouped[name].forEach(v => {
                    const label = [v.style, v.color, v.size !== 'N/A' ? v.size : ''].filter(Boolean).join(' / ') || 'Default';
                    const cost = +v.cost || 0;
                    const price = +v.price || 0;
                    const margin = price > 0 ? (((price - cost) / price) * 100).toFixed(1) : '0.0';
                    const vData = variantSalesMap[v.id] || { units: 0, revenue: 0, profit: 0 };
                    rows.push({ name, label, cost, price, margin, units: vData.units, stock: +v.stock || 0, revenue: vData.revenue, profit: vData.profit });
                });
            });

            if (!rows.length) {
                body.innerHTML = `<tr><td colspan="9" style="text-align:center;color:#7f8c8d;padding:20px;">No products found.</td></tr>`;
                return;
            }

            body.innerHTML = rows.map(r => `
                <tr>
                    <td><b>${escapeHtml(r.name)}</b></td>
                    <td>${escapeHtml(r.label)}</td>
                    <td style="color:#c0392b;font-weight:600;">₦${r.cost.toLocaleString()}</td>
                    <td style="color:var(--odoo-teal);font-weight:600;">₦${r.price.toLocaleString()}</td>
                    <td class="${+r.margin >= 20 ? 'margin-good' : 'margin-low'}">${r.margin}%</td>
                    <td style="font-weight:800;color:var(--odoo-purple);">${r.units}</td>
                    <td><span class="badge ${r.stock > 5 ? 'badge-active' : r.stock > 0 ? 'badge-suspended' : 'badge-deleted'}">${r.stock}</span></td>
                    <td style="color:var(--odoo-teal);font-weight:700;">₦${r.revenue.toLocaleString()}</td>
                    <td style="font-weight:700;color:${r.profit >= 0 ? '#27ae60' : '#e74c3c'};">₦${r.profit.toLocaleString()}</td>
                </tr>`).join('');
        }

        // ===================== EXCEL EXPORTS =====================
        function exportVariantAnalyticsExcel() {
            if (typeof XLSX === 'undefined') return showToast('Excel library not loaded', 'error');
            const grouped = {};
            db_inv.forEach(p => { if (!grouped[p.name]) grouped[p.name] = []; grouped[p.name].push(p); });
            const variantSalesMap = {};
            db_inv.forEach(v => { variantSalesMap[v.id] = { units: 0, revenue: 0, profit: 0 }; });
            db_sales.forEach(sale => {
                (sale.items || []).forEach(it => {
                    if (variantSalesMap[it.id] !== undefined) {
                        const v = db_inv.find(x => x.id == it.id);
                        if (!v) return;
                        variantSalesMap[it.id].units += +it.qty || 0;
                        variantSalesMap[it.id].revenue += (+it.qty || 0) * (+v.price || 0);
                        variantSalesMap[it.id].profit += (+it.qty || 0) * ((+v.price || 0) - (+v.cost || 0));
                    }
                });
            });
            const rows = [['Product', 'Variant', 'Cost (₦)', 'Price (₦)', 'Margin %', 'Units Sold', 'Stock Left', 'Revenue (₦)', 'Profit (₦)']];
            Object.keys(grouped).forEach(name => {
                grouped[name].forEach(v => {
                    const label = [v.style, v.color, v.size !== 'N/A' ? v.size : ''].filter(Boolean).join(' / ') || 'Default';
                    const cost = +v.cost || 0; const price = +v.price || 0;
                    const margin = price > 0 ? (((price - cost) / price) * 100).toFixed(1) : '0.0';
                    const vd = variantSalesMap[v.id] || { units: 0, revenue: 0, profit: 0 };
                    rows.push([name, label, cost, price, margin, vd.units, +v.stock || 0, vd.revenue, vd.profit]);
                });
            });
            const ws = XLSX.utils.aoa_to_sheet(rows);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'Variant Analytics');
            XLSX.writeFile(wb, `variant_analytics_${new Date().toISOString().slice(0,10)}.xlsx`);
            showToast('Variant analytics exported to Excel!');
        }

        function exportAnalyticsToExcel() {
            if (typeof XLSX === 'undefined') return showToast('Excel library not loaded', 'error');
            const filteredAcc = filterAccounting();
            const wb = XLSX.utils.book_new();

            // Sheet 1: Sales Ledger
            const ledgerRows = [['Invoice #', 'Customer', 'Cashier', 'Date', 'Total (₦)', 'Profit (₦)', 'Payment Method']];
            filteredAcc.forEach(a => ledgerRows.push([a.inv, a.customer, a.cashier, a.date, a.total, a.profit, a.paymentMethod || 'Cash']));
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ledgerRows), 'Sales Ledger');

            // Sheet 2: Variant Analytics
            const variantSalesMap = {};
            db_inv.forEach(v => { variantSalesMap[v.id] = { units: 0, revenue: 0, profit: 0 }; });
            db_sales.forEach(sale => {
                (sale.items || []).forEach(it => {
                    if (variantSalesMap[it.id] !== undefined) {
                        const v = db_inv.find(x => x.id == it.id);
                        if (!v) return;
                        variantSalesMap[it.id].units += +it.qty || 0;
                        variantSalesMap[it.id].revenue += (+it.qty || 0) * (+v.price || 0);
                        variantSalesMap[it.id].profit += (+it.qty || 0) * ((+v.price || 0) - (+v.cost || 0));
                    }
                });
            });
            const vRows = [['Product', 'Variant', 'Cost (₦)', 'Price (₦)', 'Margin %', 'Units Sold', 'Stock Left', 'Revenue (₦)', 'Profit (₦)']];
            db_inv.forEach(v => {
                const label = [v.style, v.color, v.size !== 'N/A' ? v.size : ''].filter(Boolean).join(' / ') || 'Default';
                const cost = +v.cost || 0; const price = +v.price || 0;
                const margin = price > 0 ? (((price - cost) / price) * 100).toFixed(1) : '0.0';
                const vd = variantSalesMap[v.id] || { units: 0, revenue: 0, profit: 0 };
                vRows.push([v.name, label, cost, price, margin, vd.units, +v.stock || 0, vd.revenue, vd.profit]);
            });
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(vRows), 'Variant Analytics');

            // Sheet 3: Summary Metrics
            const rev = filteredAcc.reduce((s, a) => s + (+a.total || 0), 0);
            const profit = filteredAcc.reduce((s, a) => s + (+a.profit || 0), 0);
            const costs = db_purch.reduce((s, p) => s + (p.qty * p.unitCost), 0);
            const summaryRows = [
                ['Metric', 'Value'],
                ['Total Revenue (₦)', rev],
                ['Total Profit (₦)', profit],
                ['Total Purchase Costs (₦)', costs],
                ['Number of Transactions', filteredAcc.length],
                ['Report Generated', new Date().toLocaleString('en-NG')],
                ['Filter Applied', (document.getElementById('report-filter') || {}).value || 'all']
            ];
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryRows), 'Summary');

            XLSX.writeFile(wb, `financial_report_${new Date().toISOString().slice(0,10)}.xlsx`);
            showToast('Full financial report exported to Excel!');
        }

        // ===================== INIT =====================
        document.addEventListener('DOMContentLoaded', () => {
            // Wire up confirm button
            const confirmBtn = document.getElementById('confirm-yes');
            if (confirmBtn) confirmBtn.addEventListener('click', () => {
                if (confirmActionCallback) confirmActionCallback();
                closeConfirmModal();
            });
            startLiveClock();
            initSupabaseSync();
            renderChat();
            fillBusinessForm();
            calculateTotal();
        });
    