
export class ChatManager {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.messages = [];
        this.isGenerating = false;
        this.render();
        this.attachEvents();
    }

    render() {
        this.container.innerHTML = `
            <div class="chat-header">
                <span>AI Assistant</span>
            </div>
            <div class="chat-messages" id="chat-messages">
                <div class="message ai">
                    <div class="message-content">Hello! I'm your terminal assistant. How can I help you today?</div>
                </div>
            </div>
            <form class="chat-input-form" id="chat-form">
                <input type="text" id="chat-input" placeholder="Ask something..." autocomplete="off" required>
                <button type="submit" id="chat-submit" aria-label="Send">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="22" y1="2" x2="11" y2="13"></line>
                        <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                    </svg>
                </button>
            </form>
        `;
        this.messagesContainer = document.getElementById('chat-messages');
        this.form = document.getElementById('chat-form');
        this.input = document.getElementById('chat-input');
        this.submitBtn = document.getElementById('chat-submit');
    }

    attachEvents() {
        this.form.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (this.isGenerating) return;

            const text = this.input.value.trim();
            if (!text) return;

            this.addMessage('user', text);
            this.input.value = '';
            this.isGenerating = true;
            this.updateUIState();

            try {
                await this.sendMessage(text);
            } catch (error) {
                this.addMessage('error', 'Failed to send message. Please try again.');
                console.error(error);
            } finally {
                this.isGenerating = false;
                this.updateUIState();
                this.input.focus();
            }
        });
    }

    updateUIState() {
        if (this.isGenerating) {
            this.submitBtn.disabled = true;
            this.input.disabled = true;
            this.submitBtn.classList.add('loading');
        } else {
            this.submitBtn.disabled = false;
            this.input.disabled = false;
            this.submitBtn.classList.remove('loading');
        }
    }

    addMessage(role, text) {
        const msgDiv = document.createElement('div');
        msgDiv.className = `message ${role}`;
        
        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        contentDiv.textContent = text;
        
        msgDiv.appendChild(contentDiv);
        this.messagesContainer.appendChild(msgDiv);
        this.scrollToBottom();
        return contentDiv; // Return for streaming updates
    }

    scrollToBottom() {
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    }

    async sendMessage(text) {
        // Create a placeholder for the AI response
        const aiMsgContent = this.addMessage('ai', '');
        aiMsgContent.classList.add('streaming');

        // Get auth token
        const token = localStorage.getItem('tabminal_auth_token');
        const headers = {
            'Content-Type': 'application/json'
        };
        if (token) {
            headers['Authorization'] = token;
        }

        const response = await fetch('/api/chat', {
            method: 'POST',
            headers,
            body: JSON.stringify({ message: text })
        });

        if (!response.ok) {
            throw new Error(`API Error: ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let aiText = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const chunk = decoder.decode(value, { stream: true });
            aiText += chunk;
            aiMsgContent.textContent = aiText;
            this.scrollToBottom();
        }
        
        aiMsgContent.classList.remove('streaming');
    }
}
