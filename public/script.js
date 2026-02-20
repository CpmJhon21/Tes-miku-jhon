// ========== KONFIGURASI ==========
const CONFIG = {
    DB_NAME: 'jhonMailDB',
    DB_VERSION: 2,
    STORE_NAME: 'messages',
    STORE_ACCOUNTS: 'accounts',
    STORE_SETTINGS: 'settings',
    STORE_STARRED: 'starred',
    REFRESH_INTERVAL: 10,
    REQUEST_TIMEOUT: 10000,
    MAX_RETRY: 3,
    DEBUG: true,
    VIRTUAL_SCROLL_ITEM_HEIGHT: 90,
    VIRTUAL_SCROLL_BUFFER: 5,
    PAGINATION_PAGE_SIZE: 20,
    SYNC_INTERVAL: 30000,
    MAX_STORAGE_SIZE: 50 * 1024 * 1024
};

// ========== STATE MANAGEMENT ==========
let currentEmail = localStorage.getItem('jhon_mail') || null;
let db = null;
let autoRefreshInterval = null;
let refreshTimeLeft = CONFIG.REFRESH_INTERVAL;
let pendingConfirmation = null;
let currentFilter = {
    status: 'all',
    date: 'all',
    search: '',
    dateFrom: null,
    dateTo: null
};
let currentPage = {
    inbox: 1,
    updates: 1
};
let totalPages = {
    inbox: 1,
    updates: 1
};
let syncInterval = null;
let currentAccount = localStorage.getItem('jhon_current_account') || 'default';
let accounts = JSON.parse(localStorage.getItem('jhon_accounts') || '{"default": {"name": "Default", "email": null}}');
let starredMessages = new Set(JSON.parse(localStorage.getItem('jhon_starred') || '[]'));
let darkMode = localStorage.getItem('jhon_darkmode') === 'true';
let analytics = {
    messagesReceived: 0,
    messagesRead: 0,
    emailsGenerated: 0,
    lastSync: null,
    storageUsed: 0
};

// ========== CLASS MessageDB ==========
class MessageDB {
    constructor(dbName, storeName) {
        this.dbName = dbName;
        this.storeName = storeName;
        this.db = null;
    }

    async init() {
        return new Promise((resolve, reject) => {
            try {
                const request = indexedDB.open(this.dbName, CONFIG.DB_VERSION);
                
                request.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    
                    if (!db.objectStoreNames.contains(this.storeName)) {
                        const messageStore = db.createObjectStore(this.storeName, { keyPath: 'id' });
                        messageStore.createIndex('account', 'account', { unique: false });
                        messageStore.createIndex('created', 'created', { unique: false });
                        messageStore.createIndex('isRead', 'isRead', { unique: false });
                    }
                    
                    if (!db.objectStoreNames.contains(CONFIG.STORE_ACCOUNTS)) {
                        const accountStore = db.createObjectStore(CONFIG.STORE_ACCOUNTS, { keyPath: 'id' });
                        accountStore.createIndex('email', 'email', { unique: true });
                    }
                    
                    if (!db.objectStoreNames.contains(CONFIG.STORE_SETTINGS)) {
                        db.createObjectStore(CONFIG.STORE_SETTINGS);
                    }
                    
                    log('Database upgraded to version', CONFIG.DB_VERSION);
                };
                
                request.onsuccess = (e) => { 
                    this.db = e.target.result;
                    
                    this.db.onclose = () => {
                        log('Database connection closed');
                        this.db = null;
                    };
                    
                    this.db.onerror = (e) => {
                        log('Database error:', e.target.error);
                    };
                    
                    log('Database initialized successfully');
                    resolve(this.db);
                };
                
                request.onerror = (e) => { 
                    log('Database initialization failed:', e.target.error);
                    reject(new Error('Failed to open database: ' + e.target.error));
                };
            } catch (e) {
                reject(e);
            }
        });
    }

    async ensureConnection() {
        if (!this.db) {
            await this.init();
        }
        return this.db;
    }

    async save(message) {
        try {
            await this.ensureConnection();
            
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(this.storeName, 'readwrite');
                const store = tx.objectStore(this.storeName);
                
                message.account = currentAccount;
                message.starred = starredMessages.has(message.id);
                
                const request = store.put(message);
                
                request.onsuccess = () => {
                    log('Message saved:', message.id, 'isRead:', message.isRead);
                    this.updateAnalytics();
                    resolve();
                };
                
                request.onerror = (e) => {
                    log('Save failed:', e.target.error);
                    reject(new Error('Failed to save message: ' + e.target.error));
                };
            });
        } catch (e) {
            log('Save error:', e);
            throw e;
        }
    }

    async getAll(filter = {}, page = 1, pageSize = CONFIG.PAGINATION_PAGE_SIZE) {
        try {
            await this.ensureConnection();
            
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(this.storeName, 'readonly');
                const store = tx.objectStore(this.storeName);
                const request = store.getAll();
                
                request.onsuccess = () => {
                    let messages = request.result || [];
                    
                    // Filter by account
                    messages = messages.filter(m => m.account === currentAccount);
                    
                    // Log untuk debugging
                    log('All messages before filter:', messages.length);
                    log('Current filter:', filter);
                    
                    // Apply filters
                    messages = this.applyFilters(messages, filter);
                    
                    log('Messages after filter:', messages.length);
                    
                    // Sort by date descending
                    messages.sort((a, b) => {
                        try {
                            return new Date(b.created) - new Date(a.created);
                        } catch {
                            return 0;
                        }
                    });
                    
                    const total = messages.length;
                    const start = (page - 1) * pageSize;
                    const end = start + pageSize;
                    
                    resolve({
                        items: messages.slice(start, end),
                        total: total,
                        page: page,
                        totalPages: Math.ceil(total / pageSize)
                    });
                };
                
                request.onerror = (e) => {
                    log('Get all failed:', e.target.error);
                    reject(new Error('Failed to get messages: ' + e.target.error));
                };
            });
        } catch (e) {
            log('Get all error:', e);
            return { items: [], total: 0, page: 1, totalPages: 1 };
        }
    }

    applyFilters(messages, filter) {
        return messages.filter(msg => {
            // Status filter
            if (filter.status === 'unread' && msg.isRead) {
                return false;
            }
            if (filter.status === 'read' && !msg.isRead) {
                return false;
            }
            
            // Date filter
            if (filter.date && filter.date !== 'all') {
                try {
                    const msgDate = new Date(msg.created);
                    const today = new Date();
                    
                    // Reset time to start of day for date comparison
                    const startOfDay = new Date(today);
                    startOfDay.setHours(0, 0, 0, 0);
                    
                    switch(filter.date) {
                        case 'today':
                            const msgDay = new Date(msgDate);
                            msgDay.setHours(0, 0, 0, 0);
                            if (msgDay.getTime() !== startOfDay.getTime()) {
                                return false;
                            }
                            break;
                        case 'week':
                            const weekAgo = new Date(today);
                            weekAgo.setDate(weekAgo.getDate() - 7);
                            if (msgDate < weekAgo) {
                                return false;
                            }
                            break;
                        case 'month':
                            const monthAgo = new Date(today);
                            monthAgo.setMonth(monthAgo.getMonth() - 1);
                            if (msgDate < monthAgo) {
                                return false;
                            }
                            break;
                        case 'custom':
                            if (filter.dateFrom) {
                                const fromDate = new Date(filter.dateFrom);
                                fromDate.setHours(0, 0, 0, 0);
                                if (msgDate < fromDate) {
                                    return false;
                                }
                            }
                            if (filter.dateTo) {
                                const toDate = new Date(filter.dateTo);
                                toDate.setHours(23, 59, 59, 999);
                                if (msgDate > toDate) {
                                    return false;
                                }
                            }
                            break;
                    }
                } catch (e) {
                    log('Date filter error:', e);
                }
            }
            
            // Search filter
            if (filter.search && filter.search.trim() !== '') {
                const searchLower = filter.search.toLowerCase().trim();
                const matches = 
                    (msg.from && msg.from.toLowerCase().includes(searchLower)) ||
                    (msg.subject && msg.subject.toLowerCase().includes(searchLower)) ||
                    (msg.message && msg.message.toLowerCase().includes(searchLower));
                
                if (!matches) {
                    return false;
                }
            }
            
            return true;
        });
    }

    async getById(id) {
        try {
            await this.ensureConnection();
            
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(this.storeName, 'readonly');
                const store = tx.objectStore(this.storeName);
                const request = store.get(id);
                
                request.onsuccess = () => {
                    resolve(request.result);
                };
                
                request.onerror = (e) => {
                    reject(new Error('Failed to get message: ' + e.target.error));
                };
            });
        } catch (e) {
            log('Get by id error:', e);
            return null;
        }
    }

    async clear() {
        try {
            await this.ensureConnection();
            
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(this.storeName, 'readwrite');
                const store = tx.objectStore(this.storeName);
                
                const request = store.openCursor();
                request.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (cursor) {
                        if (cursor.value.account === currentAccount) {
                            cursor.delete();
                        }
                        cursor.continue();
                    } else {
                        resolve();
                    }
                };
                
                request.onerror = (e) => {
                    reject(new Error('Failed to clear database: ' + e.target.error));
                };
            });
        } catch (e) {
            log('Clear error:', e);
            throw e;
        }
    }

    async delete(id) {
        try {
            await this.ensureConnection();
            
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(this.storeName, 'readwrite');
                const store = tx.objectStore(this.storeName);
                const request = store.delete(id);
                
                request.onsuccess = () => {
                    starredMessages.delete(id);
                    localStorage.setItem('jhon_starred', JSON.stringify([...starredMessages]));
                    log('Message deleted:', id);
                    resolve();
                };
                
                request.onerror = (e) => {
                    log('Delete failed:', e.target.error);
                    reject(new Error('Failed to delete message: ' + e.target.error));
                };
            });
        } catch (e) {
            log('Delete error:', e);
            throw e;
        }
    }

    async updateAnalytics() {
        try {
            const result = await this.getAll();
            analytics.messagesReceived = result.total;
            analytics.messagesRead = result.items.filter(m => m.isRead).length;
            
            const serialized = JSON.stringify(result.items);
            analytics.storageUsed = new Blob([serialized]).size;
            
            this.saveAnalytics();
        } catch (e) {
            log('Update analytics error:', e);
        }
    }

    saveAnalytics() {
        localStorage.setItem('jhon_analytics', JSON.stringify(analytics));
    }
}

// Inisialisasi database
const messageDB = new MessageDB(CONFIG.DB_NAME, CONFIG.STORE_NAME);

// ========== UTILITY FUNCTIONS ==========
function log(...args) {
    if (CONFIG.DEBUG) {
        console.log('[TempMail]', ...args);
    }
}

function showToast(message, type = 'info', duration = 2000) {
    const toast = document.getElementById('toast');
    toast.innerText = message;
    toast.className = 'toast';
    
    if (type === 'error') toast.classList.add('error');
    if (type === 'success') toast.classList.add('success');
    
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), duration);
}

function showGlobalLoading(show = true) {
    const loader = document.getElementById('globalLoading');
    if (loader) {
        loader.style.display = show ? 'flex' : 'none';
    }
}

function showSkeleton(type, show = true) {
    const skeletonId = type === 'inbox' ? 'readListSkeleton' : 'unreadListSkeleton';
    const listId = type === 'inbox' ? 'readList' : 'unreadList';
    
    const skeleton = document.getElementById(skeletonId);
    const list = document.getElementById(listId);
    
    if (skeleton && list) {
        skeleton.style.display = show ? 'block' : 'none';
        list.style.display = show ? 'none' : 'block';
    }
}

function setButtonLoading(buttonId, loading = true) {
    const btn = document.getElementById(buttonId);
    if (btn) {
        if (loading) {
            btn.classList.add('button-loading');
            btn.disabled = true;
        } else {
            btn.classList.remove('button-loading');
            btn.disabled = false;
        }
    }
}

function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.add('show');
        document.body.classList.add('modal-open');
    }
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('show');
        document.body.classList.remove('modal-open');
    }
}

function closeAllModals() {
    document.querySelectorAll('.modal.show').forEach(modal => {
        modal.classList.remove('show');
    });
    document.body.classList.remove('modal-open');
}

function showConfirm(title, message, onConfirm) {
    const modal = document.getElementById('confirmModal');
    document.getElementById('confirmTitle').innerText = title;
    document.getElementById('confirmMessage').innerText = message;
    
    pendingConfirmation = onConfirm;
    
    modal.classList.add('show');
    document.body.classList.add('modal-open');
}

function confirmAction(confirmed) {
    const modal = document.getElementById('confirmModal');
    modal.classList.remove('show');
    document.body.classList.remove('modal-open');
    
    if (confirmed && pendingConfirmation) {
        pendingConfirmation();
    }
    pendingConfirmation = null;
}

async function fetchWithTimeout(resource, options = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);
    
    try {
        const response = await fetch(resource, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        
        if (!data || typeof data !== 'object') {
            throw new Error('Invalid response format');
        }
        
        return data;
    } catch (error) {
        clearTimeout(timeoutId);
        
        if (error.name === 'AbortError') {
            throw new Error('Request timeout');
        }
        throw error;
    }
}

function isValidMessageId(id) {
    return id && typeof id === 'string' && id.length > 0;
}

function isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return email && typeof email === 'string' && emailRegex.test(email);
}

function escapeString(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function formatDate(dateStr) {
    try {
        const date = new Date(dateStr);
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        if (diffMins < 1) return 'Baru saja';
        if (diffMins < 60) return `${diffMins} menit lalu`;
        if (diffHours < 24) return `${diffHours} jam lalu`;
        if (diffDays < 7) return `${diffDays} hari lalu`;
        
        return date.toLocaleDateString('id-ID', { 
            day: 'numeric', 
            month: 'short', 
            hour: '2-digit', 
            minute: '2-digit' 
        });
    } catch (e) {
        return dateStr;
    }
}

// ========== SYNC FUNCTIONS ==========
function initSync() {
    if (syncInterval) {
        clearInterval(syncInterval);
    }
    
    syncInterval = setInterval(async () => {
        await syncWithOtherTabs();
    }, CONFIG.SYNC_INTERVAL);
    
    window.addEventListener('storage', (e) => {
        if (e.key === 'jhon_sync_trigger') {
            handleSyncFromOtherTab();
        }
    });
}

async function syncWithOtherTabs() {
    try {
        const result = await messageDB.getAll();
        const data = {
            timestamp: Date.now(),
            messages: result.items,
            accounts: accounts,
            currentAccount: currentAccount,
            starred: [...starredMessages]
        };
        
        localStorage.setItem('jhon_sync_data', JSON.stringify(data));
        localStorage.setItem('jhon_sync_trigger', Date.now().toString());
        
        analytics.lastSync = new Date().toISOString();
        messageDB.saveAnalytics();
    } catch (e) {
        log('Sync error:', e);
    }
}

async function handleSyncFromOtherTab() {
    try {
        const syncData = localStorage.getItem('jhon_sync_data');
        if (!syncData) return;
        
        const data = JSON.parse(syncData);
        
        if (data.timestamp > (analytics.lastSync ? new Date(analytics.lastSync).getTime() : 0)) {
            accounts = data.accounts;
            localStorage.setItem('jhon_accounts', JSON.stringify(accounts));
            
            if (data.currentAccount !== currentAccount) {
                currentAccount = data.currentAccount;
                localStorage.setItem('jhon_current_account', currentAccount);
                await loadCachedMessages();
            }
            
            starredMessages = new Set(data.starred);
            localStorage.setItem('jhon_starred', JSON.stringify([...starredMessages]));
        }
    } catch (e) {
        log('Sync handling error:', e);
    }
}

// ========== BACKUP & RESTORE ==========
async function exportBackup() {
    try {
        showGlobalLoading(true);
        
        const result = await messageDB.getAll({}, 1, 9999);
        const backup = {
            version: CONFIG.DB_VERSION,
            timestamp: new Date().toISOString(),
            data: {
                messages: result.items,
                accounts: accounts,
                starred: [...starredMessages],
                analytics: analytics,
                settings: {
                    darkMode: darkMode,
                    refreshInterval: CONFIG.REFRESH_INTERVAL
                }
            }
        };
        
        const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `tempmail-backup-${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        
        URL.revokeObjectURL(url);
        showToast('Backup berhasil dibuat', 'success');
        closeModal('backupModal');
    } catch (e) {
        log('Export backup error:', e);
        showToast('Gagal membuat backup', 'error');
    } finally {
        showGlobalLoading(false);
    }
}

async function importBackup(input) {
    const file = input.files[0];
    if (!file) return;
    
    try {
        showGlobalLoading(true);
        
        const text = await file.text();
        const backup = JSON.parse(text);
        
        if (!backup.version || !backup.data) {
            throw new Error('Format backup tidak valid');
        }
        
        if (backup.data.messages) {
            await messageDB.clear();
            for (const msg of backup.data.messages) {
                await messageDB.save(msg);
            }
        }
        
        if (backup.data.accounts) {
            accounts = backup.data.accounts;
            localStorage.setItem('jhon_accounts', JSON.stringify(accounts));
        }
        
        if (backup.data.starred) {
            starredMessages = new Set(backup.data.starred);
            localStorage.setItem('jhon_starred', JSON.stringify([...starredMessages]));
        }
        
        if (backup.data.settings) {
            darkMode = backup.data.settings.darkMode;
            if (darkMode) document.body.classList.add('dark-mode');
            else document.body.classList.remove('dark-mode');
            localStorage.setItem('jhon_darkmode', darkMode);
        }
        
        await loadCachedMessages();
        showToast('Backup berhasil direstore', 'success');
        closeModal('backupModal');
    } catch (e) {
        log('Import backup error:', e);
        showToast('Gagal merestore backup: ' + e.message, 'error');
    } finally {
        showGlobalLoading(false);
        input.value = '';
    }
}

function showBackupModal() {
    const totalMsg = document.getElementById('backupTotalMsg');
    const backupSize = document.getElementById('backupSize');
    
    totalMsg.textContent = analytics.messagesReceived || 0;
    
    const size = analytics.storageUsed || 0;
    if (size < 1024) {
        backupSize.textContent = size + ' B';
    } else if (size < 1024 * 1024) {
        backupSize.textContent = (size / 1024).toFixed(2) + ' KB';
    } else {
        backupSize.textContent = (size / (1024 * 1024)).toFixed(2) + ' MB';
    }
    
    openModal('backupModal');
}

// ========== MULTIPLE ACCOUNTS ==========
async function switchAccount(accountId) {
    currentAccount = accountId;
    localStorage.setItem('jhon_current_account', accountId);
    
    currentEmail = accounts[accountId].email;
    if (currentEmail) {
        localStorage.setItem('jhon_mail', currentEmail);
        document.getElementById('emailAddress').innerText = currentEmail;
    }
    
    await loadCachedMessages();
    showToast(`Beralih ke ${accounts[accountId].name}`, 'success');
    closeModal('accountsModal');
}

function showAccountsModal() {
    const accountsList = document.getElementById('accountsList');
    let html = '';
    
    Object.keys(accounts).forEach(accountId => {
        const account = accounts[accountId];
        const isActive = accountId === currentAccount;
        
        html += `
            <div class="account-item ${isActive ? 'active' : ''}" onclick="switchAccount('${accountId}')">
                <div class="account-avatar">${account.name.charAt(0).toUpperCase()}</div>
                <div class="account-info">
                    <div class="account-name">${account.name}</div>
                    <div class="account-email">${account.email || 'Belum ada email'}</div>
                </div>
                ${isActive ? '<i class="bi bi-check-circle-fill account-check"></i>' : ''}
            </div>
        `;
    });
    
    accountsList.innerHTML = html || '<div class="empty-placeholder">Belum ada account</div>';
    openModal('accountsModal');
}

function showAddAccountModal() {
    document.getElementById('newAccountName').value = '';
    document.getElementById('newAccountEmail').value = '';
    openModal('addAccountModal');
}

async function addNewAccount() {
    const name = document.getElementById('newAccountName').value.trim();
    const email = document.getElementById('newAccountEmail').value.trim();
    
    if (!name) {
        showToast('Nama account harus diisi', 'error');
        return;
    }
    
    const accountId = 'account_' + Date.now();
    
    accounts[accountId] = {
        name: name,
        email: email || null
    };
    
    localStorage.setItem('jhon_accounts', JSON.stringify(accounts));
    
    if (email) {
        currentEmail = email;
        currentAccount = accountId;
        localStorage.setItem('jhon_mail', email);
        localStorage.setItem('jhon_current_account', accountId);
        document.getElementById('emailAddress').innerText = email;
        await loadCachedMessages();
    }
    
    closeModal('addAccountModal');
    showAccountsModal();
    showToast('Account berhasil ditambahkan', 'success');
}

// ========== DARK MODE ==========
function toggleDarkMode() {
    darkMode = !darkMode;
    
    if (darkMode) {
        document.body.classList.add('dark-mode');
    } else {
        document.body.classList.remove('dark-mode');
    }
    
    localStorage.setItem('jhon_darkmode', darkMode);
    showToast(darkMode ? 'Dark mode aktif' : 'Light mode aktif', 'success');
}

// ========== FILTER FUNCTIONS ==========
function showFilterModal() {
    document.querySelectorAll('.filter-chip').forEach(chip => {
        if (chip.dataset.status === currentFilter.status) {
            chip.classList.add('active');
        } else {
            chip.classList.remove('active');
        }
    });
    
    document.getElementById('filterDate').value = currentFilter.date;
    document.getElementById('filterSearch').value = currentFilter.search;
    document.getElementById('filterDateFrom').value = currentFilter.dateFrom || '';
    document.getElementById('filterDateTo').value = currentFilter.dateTo || '';
    
    document.getElementById('customDateRange').style.display = 
        currentFilter.date === 'custom' ? 'block' : 'none';
    
    openModal('filterModal');
}

function applyFilter() {
    const activeChip = document.querySelector('.filter-chip.active');
    currentFilter.status = activeChip ? activeChip.dataset.status : 'all';
    
    currentFilter.date = document.getElementById('filterDate').value;
    
    if (currentFilter.date === 'custom') {
        currentFilter.dateFrom = document.getElementById('filterDateFrom').value;
        currentFilter.dateTo = document.getElementById('filterDateTo').value;
        
        // Validasi tanggal
        if (currentFilter.dateFrom && currentFilter.dateTo) {
            if (new Date(currentFilter.dateFrom) > new Date(currentFilter.dateTo)) {
                showToast('Tanggal "Dari" harus sebelum "Sampai"', 'error');
                return;
            }
        }
    } else {
        currentFilter.dateFrom = null;
        currentFilter.dateTo = null;
    }
    
    currentFilter.search = document.getElementById('filterSearch').value;
    
    log('Applied filter:', currentFilter);
    
    closeModal('filterModal');
    
    // Reset ke halaman 1
    currentPage.inbox = 1;
    currentPage.updates = 1;
    
    loadCachedMessages();
    showToast('Filter diterapkan', 'success');
}

function resetFilter() {
    currentFilter = {
        status: 'all',
        date: 'all',
        search: '',
        dateFrom: null,
        dateTo: null
    };
    
    // Reset UI
    document.querySelectorAll('.filter-chip').forEach(chip => {
        if (chip.dataset.status === 'all') {
            chip.classList.add('active');
        } else {
            chip.classList.remove('active');
        }
    });
    
    document.getElementById('filterDate').value = 'all';
    document.getElementById('filterSearch').value = '';
    document.getElementById('filterDateFrom').value = '';
    document.getElementById('filterDateTo').value = '';
    document.getElementById('customDateRange').style.display = 'none';
    
    log('Filter reset');
    
    closeModal('filterModal');
    
    // Reset ke halaman 1
    currentPage.inbox = 1;
    currentPage.updates = 1;
    
    loadCachedMessages();
    showToast('Filter direset', 'success');
}

// ========== MARK ALL AS READ ==========
async function markAllAsRead() {
    try {
        showGlobalLoading(true);
        
        const result = await messageDB.getAll({}, 1, 9999);
        const unreadMessages = result.items.filter(m => !m.isRead);
        
        log('Marking as read:', unreadMessages.length, 'messages');
        
        for (const msg of unreadMessages) {
            msg.isRead = true;
            await messageDB.save(msg);
        }
        
        await loadCachedMessages();
        showToast(`${unreadMessages.length} pesan ditandai telah dibaca`, 'success');
    } catch (e) {
        log('Mark all as read error:', e);
        showToast('Gagal menandai pesan', 'error');
    } finally {
        showGlobalLoading(false);
    }
}

// ========== STARRED MESSAGES ==========
async function toggleStarred(msgId) {
    try {
        if (starredMessages.has(msgId)) {
            starredMessages.delete(msgId);
            showToast('Dihapus dari favorit', 'info');
        } else {
            starredMessages.add(msgId);
            showToast('Ditambahkan ke favorit', 'success');
        }
        
        localStorage.setItem('jhon_starred', JSON.stringify([...starredMessages]));
        
        const msg = await messageDB.getById(msgId);
        if (msg) {
            msg.starred = starredMessages.has(msgId);
            await messageDB.save(msg);
        }
        
        await loadCachedMessages();
    } catch (e) {
        log('Toggle starred error:', e);
        showToast('Gagal mengupdate favorit', 'error');
    }
}

// ========== KEYBOARD SHORTCUTS ==========
function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
            return;
        }
        
        const key = e.key.toLowerCase();
        
        switch(key) {
            case 'g':
                e.preventDefault();
                confirmNewEmail();
                break;
            case 'r':
                e.preventDefault();
                fetchInbox();
                break;
            case 'c':
                e.preventDefault();
                copyEmail();
                break;
            case 'f':
                e.preventDefault();
                showFilterModal();
                break;
            case '/':
                e.preventDefault();
                document.getElementById('filterSearch')?.focus();
                break;
            case 'm':
                e.preventDefault();
                markAllAsRead();
                break;
            case 'd':
                e.preventDefault();
                toggleDarkMode();
                break;
            case '1':
                e.preventDefault();
                switchTab('view-home', document.querySelector('.nav-item:first-child'));
                break;
            case '2':
                e.preventDefault();
                switchTab('view-inbox', document.querySelectorAll('.nav-item')[1]);
                break;
            case '3':
                e.preventDefault();
                switchTab('view-updates', document.querySelectorAll('.nav-item')[3]);
                break;
            case '4':
                e.preventDefault();
                switchTab('view-docs', document.querySelectorAll('.nav-item')[4]);
                break;
            case '?':
                e.preventDefault();
                showShortcutsModal();
                break;
            case 'escape':
                closeAllModals();
                break;
        }
    });
}

function showShortcutsModal() {
    openModal('shortcutsModal');
}

// ========== ANALYTICS ==========
function initAnalytics() {
    const saved = localStorage.getItem('jhon_analytics');
    if (saved) {
        analytics = JSON.parse(saved);
    }
    
    trackEvent('app_loaded');
}

function trackEvent(eventName, data = {}) {
    const event = {
        name: eventName,
        timestamp: new Date().toISOString(),
        data: data,
        account: currentAccount
    };
    
    const events = JSON.parse(localStorage.getItem('jhon_events') || '[]');
    events.push(event);
    
    if (events.length > 100) {
        events.shift();
    }
    
    localStorage.setItem('jhon_events', JSON.stringify(events));
    
    switch(eventName) {
        case 'email_generated':
            analytics.emailsGenerated++;
            break;
        case 'message_received':
            analytics.messagesReceived++;
            break;
        case 'message_read':
            analytics.messagesRead++;
            break;
    }
    
    messageDB.saveAnalytics();
}

function showAnalytics() {
    const stats = `
📊 ANALYTICS TempMail
════════════════════
📨 Pesan diterima: ${analytics.messagesReceived}
👁️ Pesan dibaca: ${analytics.messagesRead}
🔢 Email digenerate: ${analytics.emailsGenerated}
⏱️ Terakhir sync: ${analytics.lastSync ? new Date(analytics.lastSync).toLocaleString() : 'Belum'}
💾 Storage used: ${(analytics.storageUsed / 1024).toFixed(2)} KB
    `;
    
    alert(stats);
}

// ========== AUTO REFRESH ==========
function startAutoRefresh() {
    stopAutoRefresh();
    
    refreshTimeLeft = CONFIG.REFRESH_INTERVAL;
    updateTimerDisplay();
    
    autoRefreshInterval = setInterval(() => {
        refreshTimeLeft--;
        updateTimerDisplay();
        
        if (refreshTimeLeft <= 0) {
            fetchInbox();
            refreshTimeLeft = CONFIG.REFRESH_INTERVAL;
        }
    }, 1000);
}

function stopAutoRefresh() {
    if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
        autoRefreshInterval = null;
    }
}

function updateTimerDisplay() {
    const timerText = document.getElementById('timerText');
    if (timerText) {
        timerText.innerText = `Auto-refresh: ${refreshTimeLeft}s`;
    }
}

// ========== TAB NAVIGATION ==========
function switchTab(viewId, element) {
    document.querySelectorAll('.tab-view').forEach(el => el.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
    
    if(element) { 
        document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
        element.classList.add('active');
    }
}

// ========== EMAIL GENERATION ==========
async function confirmNewEmail() {
    showConfirm(
        'Buat Email Baru',
        'Email baru akan dibuat dan inbox lama akan dihapus permanen. Lanjutkan?',
        generateNewEmail
    );
}

async function generateNewEmail() {
    const emailDisplay = document.getElementById('emailAddress');
    const originalEmail = emailDisplay.innerText;
    
    emailDisplay.innerText = "Membuat ID baru...";
    setButtonLoading('newEmailFab', true);
    
    try {
        stopAutoRefresh();
        
        const data = await fetchWithTimeout('/api?action=generate');
        
        if (data.success && data.result && data.result.email) {
            await messageDB.clear();
            
            currentEmail = data.result.email;
            
            accounts[currentAccount].email = currentEmail;
            localStorage.setItem('jhon_accounts', JSON.stringify(accounts));
            localStorage.setItem('jhon_mail', currentEmail);
            
            emailDisplay.innerText = currentEmail;
            
            trackEvent('email_generated');
            
            document.getElementById('unreadList').innerHTML = emptyState('updates');
            document.getElementById('readList').innerHTML = emptyState('inbox');
            updateBadge(0);
            
            switchTab('view-home', document.querySelector('.nav-item:first-child'));
            showToast('Email baru berhasil dibuat', 'success');
            
            refreshTimeLeft = CONFIG.REFRESH_INTERVAL;
            startAutoRefresh();
        } else {
            throw new Error(data.result || 'Gagal generate email');
        }
    } catch (e) {
        log('Generate email error:', e);
        emailDisplay.innerText = originalEmail;
        showToast('Gagal: ' + e.message, 'error');
    } finally {
        setButtonLoading('newEmailFab', false);
    }
}

// ========== MESSAGE OPERATIONS ==========
async function loadCachedMessages() {
    try {
        showGlobalLoading(true);
        
        // Ambil semua pesan dengan filter
        const result = await messageDB.getAll(currentFilter, currentPage.inbox);
        totalPages.inbox = result.totalPages;
        
        // Render pesan
        renderMessages(result.items);
        
        showGlobalLoading(false);
    } catch (e) {
        log('Load cached messages error:', e);
        showToast('Gagal memuat pesan', 'error');
        showGlobalLoading(false);
    }
}

async function fetchInbox() {
    if (!currentEmail) return;

    try {
        showSkeleton('updates', true);
        showSkeleton('inbox', true);
        
        const data = await fetchWithTimeout(`/api?action=inbox&email=${encodeURIComponent(currentEmail)}`);

        if (data.success && data.result && Array.isArray(data.result.inbox)) {
            const serverMessages = data.result.inbox;
            const result = await messageDB.getAll({}, 1, 9999);
            const existingMessages = result.items;
            let newMessagesCount = 0;
            
            for (const msg of serverMessages) {
                if (!msg.from || !msg.created) continue;
                
                const msgId = `${msg.created}_${msg.from}`.replace(/\s/g, '');
                const exists = existingMessages.find(m => m.id === msgId);
                
                if (!exists) {
                    // Pesan baru masuk sebagai unread
                    await messageDB.save({ 
                        ...msg, 
                        id: msgId, 
                        isRead: false, // Penting: set false untuk pesan baru
                        message: msg.message || '(Kosong)',
                        subject: msg.subject || '(Tanpa Subjek)',
                        account: currentAccount,
                        created: msg.created || new Date().toISOString()
                    });
                    newMessagesCount++;
                    log('New message saved as unread:', msgId);
                } else {
                    log('Message already exists:', msgId, 'read status:', exists.isRead);
                }
            }
            
            if (newMessagesCount > 0) {
                trackEvent('messages_received', { count: newMessagesCount });
                showToast(`${newMessagesCount} pesan baru diterima`, 'success');
                playNotification();
            }
            
            // Refresh tampilan dengan filter saat ini
            await loadCachedMessages();
        }
    } catch (e) {
        log('Fetch inbox error:', e);
        if (e.message !== 'Request timeout') {
            showToast('Gagal mengambil pesan', 'error');
        }
    } finally {
        showSkeleton('updates', false);
        showSkeleton('inbox', false);
    }
}

function playNotification() {
    try {
        if (document.visibilityState === 'visible') {
            if (navigator.vibrate) {
                navigator.vibrate(200);
            }
        }
    } catch (e) {}
}

// ========== RENDER MESSAGES ==========
function renderMessages(messages) {
    const unreadContainer = document.getElementById('unreadList');
    const readContainer = document.getElementById('readList');
    
    let unreadHTML = '';
    let readHTML = '';
    let unreadCount = 0;

    if (!Array.isArray(messages)) {
        log('Invalid messages data');
        return;
    }

    log('Rendering messages total:', messages.length);
    
    // Reset containers
    unreadContainer.innerHTML = '';
    readContainer.innerHTML = '';

    messages.forEach((msg) => {
        if (!msg || !msg.id) return;
        
        // Log untuk debugging
        log(`Message ${msg.id} - isRead: ${msg.isRead}, from: ${msg.from}`);
        
        const initial = msg.from ? msg.from.charAt(0).toUpperCase() : '?';
        const timeDisplay = msg.created ? formatDate(msg.created) : '';
        
        const isEmailLong = msg.from && msg.from.length > 20;
        const emailClass = isEmailLong ? 'email-long' : '';
        const isStarred = starredMessages.has(msg.id);

        const html = `
            <div class="message-card ${msg.isRead ? 'read' : 'unread'}" onclick="openMessage('${escapeString(msg.id)}')">
                <div class="msg-avatar">${escapeString(initial)}</div>
                <div class="msg-content">
                    <div class="msg-header">
                        <span class="msg-from ${emailClass}" title="${escapeString(msg.from || 'Unknown')}">${escapeString(msg.from || 'Unknown')}</span>
                        <span class="msg-time">${escapeString(timeDisplay)}</span>
                    </div>
                    <div class="msg-subject" title="${escapeString(msg.subject || 'Tanpa Subjek')}">
                        ${isStarred ? '<i class="bi bi-star-fill starred-icon"></i>' : ''}
                        ${escapeString(msg.subject || '(Tanpa Subjek)')}
                    </div>
                    <div class="msg-snippet">${escapeString((msg.message || '').substring(0, 60))}${(msg.message || '').length > 60 ? '...' : ''}</div>
                </div>
            </div>
        `;

        // Pisahkan berdasarkan status read/unread
        if (msg.isRead) {
            readHTML += html;
        } else {
            unreadHTML += html;
            unreadCount++;
        }
    });

    log(`Unread count: ${unreadCount}, Read count: ${messages.length - unreadCount}`);

    // Set konten dengan empty state jika tidak ada
    unreadContainer.innerHTML = unreadHTML || emptyState('updates');
    readContainer.innerHTML = readHTML || emptyState('inbox');
    
    // Tambahkan pagination hanya untuk inbox jika ada pesan
    if (readHTML) {
        const paginationHTML = `
            <div class="pagination-controls">
                <button onclick="changePage('inbox', ${currentPage.inbox - 1})" ${currentPage.inbox <= 1 ? 'disabled' : ''}>
                    <i class="bi bi-chevron-left"></i>
                </button>
                <span>Halaman ${currentPage.inbox} dari ${totalPages.inbox}</span>
                <button onclick="changePage('inbox', ${currentPage.inbox + 1})" ${currentPage.inbox >= totalPages.inbox ? 'disabled' : ''}>
                    <i class="bi bi-chevron-right"></i>
                </button>
            </div>
        `;
        readContainer.innerHTML += paginationHTML;
    }
    
    updateBadge(unreadCount);
}

function emptyState(type) {
    const icon = type === 'updates' ? 'bi-bell-slash' : 'bi-inbox';
    const text = type === 'updates' ? 'Belum ada pesan baru.' : 'Belum ada pesan terbaca.';
    return `
        <div class="empty-placeholder">
            <i class="bi ${icon}"></i>
            <p>${text}</p>
        </div>
    `;
}

async function changePage(view, newPage) {
    if (newPage < 1 || newPage > totalPages[view]) return;
    
    currentPage[view] = newPage;
    await loadCachedMessages();
}

function updateBadge(count) {
    const badge = document.getElementById('badge-count');
    const dot = document.getElementById('nav-dot');
    
    if (count > 0) {
        badge.innerText = count;
        badge.style.display = 'inline-block';
        dot.style.display = 'block';
        document.title = `(${count}) TempMail`;
    } else {
        badge.style.display = 'none';
        dot.style.display = 'none';
        document.title = 'TempMail';
    }
}

// ========== OPEN MESSAGE ==========
async function openMessage(msgId) {
    if (!isValidMessageId(msgId)) {
        return;
    }
    
    try {
        const msg = await messageDB.getById(msgId);
        
        if (!msg) {
            showToast('Pesan tidak ditemukan', 'error');
            return;
        }

        log('Opening message:', msg.id, 'Current read status:', msg.isRead);

        trackEvent('message_read', { msgId: msgId });

        const initial = msg.from ? msg.from.charAt(0).toUpperCase() : '?';
        document.getElementById('modalSubject').innerText = msg.subject || '(Tanpa Subjek)';
        document.getElementById('modalBody').innerText = msg.message || '(Kosong)';
        
        const isEmailLong = msg.from && msg.from.length > 25;
        const emailClass = isEmailLong ? 'email-long' : '';
        
        document.getElementById('modalMeta').innerHTML = `
            <div class="meta-avatar">${escapeString(initial)}</div>
            <div class="meta-info">
                <div class="meta-from ${emailClass}" title="${escapeString(msg.from || 'Unknown')}">${escapeString(msg.from || 'Unknown')}</div>
                <div class="meta-time">${escapeString(formatDate(msg.created) || '')}</div>
            </div>
        `;
        
        const modalActions = document.querySelector('.modal-actions');
        const existingStar = document.querySelector('.star-btn');
        if (existingStar) existingStar.remove();
        
        const starBtn = document.createElement('button');
        starBtn.className = `modal-btn star-btn ${starredMessages.has(msgId) ? 'active' : ''}`;
        starBtn.innerHTML = starredMessages.has(msgId) ? '<i class="bi bi-star-fill"></i>' : '<i class="bi bi-star"></i>';
        starBtn.onclick = () => toggleStarred(msgId);
        starBtn.title = starredMessages.has(msgId) ? 'Hapus dari favorit' : 'Tambah ke favorit';
        
        modalActions.insertBefore(starBtn, modalActions.firstChild);
        
        openModal('msgModal');

        // Tandai sebagai sudah dibaca jika belum
        if (!msg.isRead) {
            msg.isRead = true;
            await messageDB.save(msg);
            log('Message marked as read:', msg.id);
            
            // Refresh tampilan
            await loadCachedMessages();
        }
    } catch (e) {
        log('Open message error:', e);
        showToast('Gagal membuka pesan', 'error');
    }
}

// ========== COPY EMAIL ==========
function copyEmail() {
    if (!currentEmail) {
        showToast('Tidak ada email', 'error');
        return;
    }
    
    navigator.clipboard.writeText(currentEmail).then(() => {
        showToast('Email disalin!', 'success');
    }).catch(() => {
        showToast('Gagal menyalin', 'error');
    });
}

// ========== CLEAR INBOX ==========
async function clearInbox() {
    showConfirm(
        'Hapus Inbox',
        'Semua pesan yang sudah dibaca akan dihapus permanen. Lanjutkan?',
        async () => {
            try {
                setButtonLoading('clearInboxBtn', true);
                
                const result = await messageDB.getAll({}, 1, 9999); // Ambil semua
                const readMessages = result.items.filter(m => m.isRead);
                
                log('Deleting read messages:', readMessages.length);
                
                for (const msg of readMessages) {
                    await messageDB.delete(msg.id);
                    log('Deleted:', msg.id);
                }
                
                // Refresh tampilan
                await loadCachedMessages();
                showToast(`${readMessages.length} pesan telah dihapus`, 'success');
            } catch (e) {
                log('Clear inbox error:', e);
                showToast('Gagal membersihkan inbox', 'error');
            } finally {
                setButtonLoading('clearInboxBtn', false);
            }
        }
    );
}

// ========== SHARE FUNCTIONS ==========
function openShareModal() {
    const capEmail = document.getElementById('capEmail');
    const capSubject = document.getElementById('capSubject');
    const capMsg = document.getElementById('capMsg');
    
    const fromElement = document.querySelector('.meta-from');
    const subjectElement = document.getElementById('modalSubject');
    const bodyElement = document.getElementById('modalBody');
    
    if (fromElement) capEmail.innerText = fromElement.innerText;
    if (subjectElement) capSubject.innerText = subjectElement.innerText;
    if (bodyElement) capMsg.innerText = bodyElement.innerText;
    
    closeModal('msgModal');
    
    setTimeout(() => {
        openModal('shareMsgModal');
    }, 300);
}

async function shareAsImage() {
    const captureCard = document.getElementById('capture-card');
    const shareBtn = document.getElementById('shareImageBtn');
    
    setButtonLoading('shareImageBtn', true);
    showToast('Membuat gambar...', 'info');
    
    try {
        captureCard.style.position = 'fixed';
        captureCard.style.left = '50%';
        captureCard.style.top = '50%';
        captureCard.style.transform = 'translate(-50%, -50%)';
        captureCard.style.zIndex = '-1';
        
        const canvas = await html2canvas(captureCard, {
            scale: 2,
            backgroundColor: '#ffffff',
            logging: false,
            allowTaint: false,
            useCORS: true
        });
        
        captureCard.style.position = '';
        captureCard.style.left = '';
        captureCard.style.top = '';
        captureCard.style.transform = '';
        captureCard.style.zIndex = '';
        
        const image = canvas.toDataURL('image/png');
        
        if (navigator.share && navigator.canShare) {
            try {
                const blob = await (await fetch(image)).blob();
                const file = new File([blob], `tempmail-${Date.now()}.png`, { type: 'image/png' });
                
                if (navigator.canShare({ files: [file] })) {
                    await navigator.share({
                        title: 'Pesan TempMail',
                        files: [file]
                    });
                    showToast('Berhasil dibagikan!', 'success');
                } else {
                    downloadImage(image);
                }
            } catch (shareErr) {
                downloadImage(image);
            }
        } else {
            downloadImage(image);
        }
    } catch (error) {
        log('HTML2Canvas error:', error);
        showToast('Gagal membuat gambar', 'error');
    } finally {
        setButtonLoading('shareImageBtn', false);
        closeModal('shareMsgModal');
    }
}

function downloadImage(imageData) {
    try {
        const link = document.createElement('a');
        link.download = `tempmail-${Date.now()}.png`;
        link.href = imageData;
        link.click();
        showToast('Gambar tersimpan', 'success');
    } catch (e) {
        log('Download error:', e);
        showToast('Gagal menyimpan gambar', 'error');
    }
}

function shareToWaText() {
    try {
        const modalSubject = document.getElementById('modalSubject').innerText;
        const modalBody = document.getElementById('modalBody').innerText;
        const modalFrom = document.querySelector('.meta-from')?.innerText || 'Unknown';
        const modalTime = document.querySelector('.meta-time')?.innerText || '';
        
        const text = `*${modalSubject}*\n\n📧 *Dari:* ${modalFrom}\n⏰ *Waktu:* ${modalTime}\n\n📝 *Pesan:*\n${modalBody}\n\n━━━━━━━━━━━━━━\n_Dikirim via TempMail - JHON FORUM_`;
        
        const waUrl = `https://wa.me/?text=${encodeURIComponent(text)}`;
        window.open(waUrl, '_blank');
        
        closeModal('shareMsgModal');
    } catch (e) {
        log('WA share error:', e);
        showToast('Gagal membuka WhatsApp', 'error');
    }
}

function copyMessageText() {
    try {
        const modalSubject = document.getElementById('modalSubject').innerText;
        const modalBody = document.getElementById('modalBody').innerText;
        const modalFrom = document.querySelector('.meta-from')?.innerText || 'Unknown';
        const modalTime = document.querySelector('.meta-time')?.innerText || '';
        
        const text = `*${modalSubject}*\nDari: ${modalFrom}\nWaktu: ${modalTime}\n\n${modalBody}`;
        
        navigator.clipboard.writeText(text).then(() => {
            showToast('Teks disalin!', 'success');
            closeModal('shareMsgModal');
        }).catch(() => {
            showToast('Gagal menyalin teks', 'error');
        });
    } catch (e) {
        log('Copy error:', e);
        showToast('Gagal menyalin teks', 'error');
    }
}

// ========== MODAL HANDLERS ==========
function setupModalClickHandlers() {
    const msgModal = document.getElementById('msgModal');
    const shareModal = document.getElementById('shareMsgModal');
    const confirmModal = document.getElementById('confirmModal');
    const filterModal = document.getElementById('filterModal');
    const backupModal = document.getElementById('backupModal');
    const accountsModal = document.getElementById('accountsModal');
    const shortcutsModal = document.getElementById('shortcutsModal');
    const addAccountModal = document.getElementById('addAccountModal');
    
    [msgModal, shareModal, confirmModal, filterModal, backupModal, accountsModal, shortcutsModal, addAccountModal].forEach(modal => {
        if (modal) {
            modal.addEventListener('click', function(event) {
                if (event.target === modal) {
                    closeModal(modal.id);
                }
            });
        }
    });
    
    document.getElementById('filterDate')?.addEventListener('change', function() {
        document.getElementById('customDateRange').style.display = 
            this.value === 'custom' ? 'block' : 'none';
    });
    
    document.querySelectorAll('.filter-chip').forEach(chip => {
        chip.addEventListener('click', function() {
            document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
            this.classList.add('active');
        });
    });
}

// ========== INITIALIZATION ==========
document.addEventListener('DOMContentLoaded', async () => {
    try {
        showGlobalLoading(true);
        
        await messageDB.init();
        initAnalytics();
        initSync();
        setupKeyboardShortcuts();
        
        if (darkMode) {
            document.body.classList.add('dark-mode');
        }
        
        if ('serviceWorker' in navigator) {
            try {
                await navigator.serviceWorker.register('/sw.js');
            } catch (swErr) {}
        }

        if (currentEmail && isValidEmail(currentEmail)) {
            document.getElementById('emailAddress').innerText = currentEmail;
            await loadCachedMessages();
            fetchInbox();
        } else {
            localStorage.removeItem('jhon_mail');
            currentEmail = null;
            generateNewEmail();
        }
        
        startAutoRefresh();
        setupModalClickHandlers();
        
    } catch (e) {
        log('Initialization error:', e);
        showToast('Gagal inisialisasi aplikasi', 'error');
    } finally {
        showGlobalLoading(false);
    }
});

// ========== CLEANUP ==========
window.addEventListener('beforeunload', function() {
    stopAutoRefresh();
    if (syncInterval) {
        clearInterval(syncInterval);
    }
    if (messageDB && messageDB.db) {
        messageDB.db.close();
    }
});

window.addEventListener('error', (event) => {
    log('Global error:', event.error);
});

window.addEventListener('unhandledrejection', (event) => {
    log('Unhandled rejection:', event.reason);
});