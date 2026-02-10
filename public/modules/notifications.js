export class NotificationManager {
    constructor() {
        this.hasPermission = false;
        if ('Notification' in window) {
            this.hasPermission = Notification.permission === 'granted';
        }
    }

    requestPermission() {
        if (!('Notification' in window)) return;
        if (Notification.permission !== 'granted' && Notification.permission !== 'denied') {
            Notification.requestPermission().then(permission => {
                this.hasPermission = permission === 'granted';
            });
        }
    }

    send(title, body) {
        if (!('Notification' in window)) return false;

        // Check permission status directly
        if (Notification.permission === 'granted') {
            try {
                new Notification(title, {
                    body: body,
                    icon: '/apple-touch-icon.png',
                    tag: 'tabminal-status'
                });
                return true;
            } catch (e) {
                console.error('Notification error:', e);
                return false;
            }
        }
        return false;
    }
}

export class ToastManager {
    constructor() {
        this.container = document.getElementById('notification-container');
    }

    show(title, message, type = 'info') {
        if (!this.container) return;

        if (message === undefined || (typeof message === 'string' && ['info', 'warning', 'error', 'success'].includes(message))) {
            type = message || 'info';
            message = title;
            title = 'Tabminal';
        }

        const existingToasts = Array.from(this.container.children);
        for (const toast of existingToasts) {
            if (toast.dataset.title === title && toast.dataset.message === message && !toast.classList.contains('hiding')) {
                this.extendLife(toast);
                return;
            }
        }

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.dataset.title = title;
        toast.dataset.message = message;

        const content = document.createElement('div');
        content.className = 'toast-content';

        const titleEl = document.createElement('div');
        titleEl.className = 'toast-title';
        titleEl.textContent = title;

        const msgEl = document.createElement('div');
        msgEl.className = 'toast-message';
        msgEl.textContent = message;

        content.appendChild(titleEl);
        content.appendChild(msgEl);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'toast-close';
        closeBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
        closeBtn.onclick = () => this.dismiss(toast);

        toast.appendChild(content);
        toast.appendChild(closeBtn);

        this.container.insertBefore(toast, this.container.firstChild);

        requestAnimationFrame(() => this.prune());

        this.startTimer(toast);
    }

    startTimer(toast) {
        if (toast.dismissTimer) clearTimeout(toast.dismissTimer);
        toast.dismissTimer = setTimeout(() => this.dismiss(toast), 5000);
    }

    extendLife(toast) {
        if (toast.dismissTimer) clearTimeout(toast.dismissTimer);
        toast.classList.remove('hiding');
        toast.style.animation = 'none';
        toast.offsetHeight;
        toast.style.animation = null;
        toast.dismissTimer = setTimeout(() => this.dismiss(toast), 3000);
    }

    prune() {
        const viewportHeight = window.innerHeight;
        const bottomLimit = viewportHeight - 20;
        const toasts = Array.from(this.container.children);

        for (const toast of toasts) {
            const rect = toast.getBoundingClientRect();
            if (rect.bottom > bottomLimit) {
                this.dismiss(toast);
            }
        }
    }

    dismiss(toast) {
        if (!toast || toast.classList.contains('hiding')) return;
        if (toast.dismissTimer) clearTimeout(toast.dismissTimer);

        toast.classList.add('hiding');

        const remove = () => {
            if (toast.parentElement) toast.remove();
        };

        toast.addEventListener('transitionend', remove, { once: true });
        setTimeout(remove, 550);
    }
}
