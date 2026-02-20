// ========== KONFIGURASI ==========
const CONFIG = {
    DB_NAME: 'jhonMailDB',
    DB_VERSION: 1,
    STORE_NAME: 'messages',
    REFRESH_INTERVAL: 10, // detik
    REQUEST_TIMEOUT: 10000, // 10 detik
    MAX_RETRY: 3,
    DEBUG: true
};

// ========== STATE MANAGEMENT ==========
let currentEmail = localStorage.getItem('jhon_mail') || null;
let db = null;
let autoRefreshInterval = null;
let refreshTimeLeft = CONFIG.REFRESH_INTERVAL;
let pendingConfirmation = null;

// ========== CLASS MessageDB - PERBAIKAN ERROR HANDLING ==========
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
                        db.createObjectStore(this.storeName, { keyPath: 'id' });
                        log('Database store created');
                    }
                };
                
                request.onsuccess = (e) => { 
                    this.db = e.target.result;
                    
                    // Handle connection closed unexpectedly
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
                
                const request = store.put(message);
                
                request.onsuccess = () => {
                    log('Message saved:', message.id);
                    resolve();
                };
                
                request.onerror = (e) => {
                    log('Save failed:', e.target.error);
                    reject(new Error('Failed to save message: ' + e.target.error));
                };
                
                tx.oncomplete = () => resolve();
                tx.onerror = (e) => reject(new Error('Transaction failed: ' + e.target.error));
            });
        } catch (e) {
            log('Save error:', e);
            throw e;
        }
    }

    async getAll() {
        try {
            await this.ensureConnection();
            
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(this.storeName, 'readonly');
                const store = tx.objectStore(this.storeName);
                const request = store.getAll();
                
                request.onsuccess = () => {
                    resolve(request.result || []);
                };
                
                request.onerror = (e) => {
                    log('Get all failed:', e.target.error);
                    reject(new Error('Failed to get messages: ' + e.target.error));
                };
            });
        } catch (e) {
            log('Get all error:', e);
            return [];
        }
    }

    async clear() {
        try {
            await this.ensureConnection();
            
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(this.storeName, 'readwrite');
                const store = tx.objectStore(this.storeName);
                const request = store.clear();
                
                request.onsuccess = () => {
                    log('Database cleared');
                    resolve();
                };
                
                request.onerror = (e) => {
                    log('Clear failed:', e.target.error);
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

// Custom confirm dialog
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

// ========== ERROR HANDLING NETWORK ==========
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
        
        // Validasi response structure
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

// ========== VALIDASI INPUT ==========
function isValidMessageId(id) {
    return id && typeof id === 'string' && id.length > 0;
}

function isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return email && typeof email === 'string' && emailRegex.test(email);
}

// ========== INISIALISASI ==========
document.addEventListener('DOMContentLoaded', async () => {
    try {
        showGlobalLoading(true);
        
        await messageDB.init();
        log('Database ready');
        
        if ('serviceWorker' in navigator) {
            try {
                await navigator.serviceWorker.register('/sw.js');
                log('Service Worker registered');
            } catch (swErr) {
                log('Service Worker registration failed:', swErr);
            }
        }

        if (currentEmail && isValidEmail(currentEmail)) {
            document.getElementById('emailAddress').innerText = currentEmail;
            await loadCachedMessages();
            fetchInbox();
        } else {
            // Hapus email tidak valid
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

// ========== MODAL HANDLERS ==========
function setupModalClickHandlers() {
    const msgModal = document.getElementById('msgModal');
    const shareModal = document.getElementById('shareMsgModal');
    const confirmModal = document.getElementById('confirmModal');
    
    [msgModal, shareModal, confirmModal].forEach(modal => {
        if (modal) {
            modal.addEventListener('click', function(event) {
                if (event.target === modal) {
                    closeModal(modal.id);
                }
            });
        }
    });
}

// ========== AUTO REFRESH - PERBAIKAN MEMORY LEAK ==========
function startAutoRefresh() {
    stopAutoRefresh(); // Bersihkan interval lama
    
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
    
    log('Auto refresh started');
}

function stopAutoRefresh() {
    if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
        autoRefreshInterval = null;
        log('Auto refresh stopped');
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
        // Hentikan auto refresh sementara
        stopAutoRefresh();
        
        const data = await fetchWithTimeout('/api?action=generate');
        
        if (data.success && data.result && data.result.email) {
            // Bersihkan database lama
            await messageDB.clear();
            
            currentEmail = data.result.email;
            localStorage.setItem('jhon_mail', currentEmail);
            emailDisplay.innerText = currentEmail;
            
            // Reset tampilan
            document.getElementById('unreadList').innerHTML = emptyState('updates');
            document.getElementById('readList').innerHTML = emptyState('inbox');
            updateBadge(0);
            
            // Kembali ke home
            switchTab('view-home', document.querySelector('.nav-item:first-child'));
            
            showToast('Email baru berhasil dibuat', 'success');
            
            // Restart auto refresh
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
        const messages = await messageDB.getAll();
        renderMessages(messages);
    } catch (e) {
        log('Load cached messages error:', e);
        showToast('Gagal memuat pesan', 'error');
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
            const existingMessages = await messageDB.getAll();
            let newMessagesCount = 0;
            
            for (const msg of serverMessages) {
                // Validasi message structure
                if (!msg.from || !msg.created) continue;
                
                const msgId = `${msg.created}_${msg.from}`.replace(/\s/g, '');
                const exists = existingMessages.find(m => m.id === msgId);
                
                if (!exists) {
                    await messageDB.save({ 
                        ...msg, 
                        id: msgId, 
                        isRead: false,
                        message: msg.message || '(Kosong)',
                        subject: msg.subject || '(Tanpa Subjek)'
                    });
                    newMessagesCount++;
                }
            }
            
            if (newMessagesCount > 0) {
                showToast(`${newMessagesCount} pesan baru diterima`, 'success');
                // Play notification sound jika ada
                playNotification();
            }
            
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

// Play notification (jika browser mengizinkan)
function playNotification() {
    try {
        // Hanya play jika tab tidak aktif? Atau biarkan user memilih
        if (document.visibilityState === 'visible') {
            // Bisa tambahkan audio beep atau vibrate
            if (navigator.vibrate) {
                navigator.vibrate(200);
            }
        }
    } catch (e) {
        // Ignore
    }
}

// ========== RENDER MESSAGES ==========
function renderMessages(messages) {
    const unreadContainer = document.getElementById('unreadList');
    const readContainer = document.getElementById('readList');
    
    let unreadHTML = '';
    let readHTML = '';
    let unreadCount = 0;

    // Validasi messages
    if (!Array.isArray(messages)) {
        log('Invalid messages data');
        return;
    }

    // Sort by date descending
    messages.sort((a, b) => {
        try {
            return new Date(b.created) - new Date(a.created);
        } catch {
            return 0;
        }
    });

    messages.forEach((msg) => {
        // Validasi setiap message
        if (!msg || !msg.id) return;
        
        const initial = msg.from ? msg.from.charAt(0).toUpperCase() : '?';
        const timeDisplay = msg.created ? (msg.created.split(' ')[1] || msg.created) : '';
        
        // Deteksi email panjang
        const isEmailLong = msg.from && msg.from.length > 20;
        const emailClass = isEmailLong ? 'email-long' : '';
        const emailTitle = msg.from || 'Unknown';

        const html = `
            <div class="message-card ${msg.isRead ? 'read' : 'unread'}" onclick="openMessage('${escapeString(msg.id)}')">
                <div class="msg-avatar">${escapeString(initial)}</div>
                <div class="msg-content">
                    <div class="msg-header">
                        <span class="msg-from ${emailClass}" title="${escapeString(emailTitle)}">${escapeString(msg.from || 'Unknown')}</span>
                        <span class="msg-time">${escapeString(timeDisplay)}</span>
                    </div>
                    <div class="msg-subject" title="${escapeString(msg.subject || 'Tanpa Subjek')}">${escapeString(msg.subject || '(Tanpa Subjek)')}</div>
                    <div class="msg-snippet">${escapeString((msg.message || '').substring(0, 60))}${(msg.message || '').length > 60 ? '...' : ''}</div>
                </div>
            </div>
        `;

        if (msg.isRead) {
            readHTML += html;
        } else {
            unreadHTML += html;
            unreadCount++;
        }
    });

    unreadContainer.innerHTML = unreadHTML || emptyState('updates');
    readContainer.innerHTML = readHTML || emptyState('inbox');
    
    updateBadge(unreadCount);
}

// Escape string untuk mencegah XSS
function escapeString(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ========== OPEN MESSAGE ==========
async function openMessage(msgId) {
    if (!isValidMessageId(msgId)) {
        log('Invalid message ID');
        return;
    }
    
    try {
        const messages = await messageDB.getAll();
        const msg = messages.find(m => m.id === msgId);
        
        if (!msg) {
            showToast('Pesan tidak ditemukan', 'error');
            return;
        }

        // Data untuk Modal
        const initial = msg.from ? msg.from.charAt(0).toUpperCase() : '?';
        document.getElementById('modalSubject').innerText = msg.subject || '(Tanpa Subjek)';
        document.getElementById('modalBody').innerText = msg.message || '(Kosong)';
        
        const isEmailLong = msg.from && msg.from.length > 25;
        const emailClass = isEmailLong ? 'email-long' : '';
        
        document.getElementById('modalMeta').innerHTML = `
            <div class="meta-avatar">${escapeString(initial)}</div>
            <div class="meta-info">
                <div class="meta-from ${emailClass}" title="${escapeString(msg.from || 'Unknown')}">${escapeString(msg.from || 'Unknown')}</div>
                <div class="meta-time">${escapeString(msg.created || '')}</div>
            </div>
        `;
        
        const modal = document.getElementById('msgModal');
        modal.classList.add('show');
        document.body.classList.add('modal-open');

        // Tandai sebagai sudah dibaca
        if (!msg.isRead) {
            msg.isRead = true;
            await messageDB.save(msg);
            await loadCachedMessages();
        }
    } catch (e) {
        log('Open message error:', e);
        showToast('Gagal membuka pesan', 'error');
    }
}

// ========== CLOSE MODAL ==========
function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('show');
        document.body.classList.remove('modal-open');
    }
}

// ========== UPDATE BADGE ==========
function updateBadge(count) {
    const badge = document.getElementById('badge-count');
    const dot = document.getElementById('nav-dot');
    
    if (count > 0) {
        badge.innerText = count;
        badge.style.display = 'inline-block';
        dot.style.display = 'block';
        
        // Update title
        document.title = `(${count}) TempMail`;
    } else {
        badge.style.display = 'none';
        dot.style.display = 'none';
        document.title = 'TempMail';
    }
}

// ========== EMPTY STATE ==========
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
                
                const messages = await messageDB.getAll();
                const readMessages = messages.filter(m => m.isRead);
                
                for (const msg of readMessages) {
                    await messageDB.delete(msg.id);
                }
                
                await loadCachedMessages();
                showToast('Inbox telah dibersihkan', 'success');
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
    // Update data capture
    const capEmail = document.getElementById('capEmail');
    const capSubject = document.getElementById('capSubject');
    const capMsg = document.getElementById('capMsg');
    
    const fromElement = document.querySelector('.meta-from');
    const subjectElement = document.getElementById('modalSubject');
    const bodyElement = document.getElementById('modalBody');
    
    if (fromElement) capEmail.innerText = fromElement.innerText;
    if (subjectElement) capSubject.innerText = subjectElement.innerText;
    if (bodyElement) capMsg.innerText = bodyElement.innerText;
    
    // Tutup modal pesan
    closeModal('msgModal');
    
    // Buka modal share
    setTimeout(() => {
        const modal = document.getElementById('shareMsgModal');
        modal.classList.add('show');
        document.body.classList.add('modal-open');
    }, 300);
}

async function shareAsImage() {
    const captureCard = document.getElementById('capture-card');
    const shareBtn = document.getElementById('shareImageBtn');
    
    setButtonLoading('shareImageBtn', true);
    showToast('Membuat gambar...', 'info');
    
    try {
        // Pastikan elemen visible
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
        
        // Kembalikan ke posisi semula
        captureCard.style.position = '';
        captureCard.style.left = '';
        captureCard.style.top = '';
        captureCard.style.transform = '';
        captureCard.style.zIndex = '';
        
        const image = canvas.toDataURL('image/png');
        
        // Cek support Web Share API
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
                log('Share error:', shareErr);
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

// ========== CLEANUP ==========
window.addEventListener('beforeunload', function() {
    stopAutoRefresh();
    
    // Close database connection
    if (messageDB && messageDB.db) {
        messageDB.db.close();
    }
});

// Global error handler
window.addEventListener('error', (event) => {
    log('Global error:', event.error);
    showToast('Terjadi kesalahan', 'error');
});

window.addEventListener('unhandledrejection', (event) => {
    log('Unhandled rejection:', event.reason);
    showToast('Terjadi kesalahan', 'error');
});