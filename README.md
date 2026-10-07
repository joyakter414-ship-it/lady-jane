# Lady Jane 👑
> Intelligent 24/7 WhatsApp AI Assistant powered by Cloudflare Workers AI (Neurons), D1 Database, and R2 Object Storage.

Named after **Lady Jane Grey**, the "Nine Days' Queen" of England (1553), renowned for her wit, intellect, and grace.

---

## 🌟 Architecture

```
[ WhatsApp User ]
       │
       ▼ (WebSocket / Multi-device)
[ Lady Jane Gateway (24/7 on GitHub Cloud / Container) ]
       │
       ▼ (Encrypted HTTPS REST Relay)
[ Lady Jane Brain (Cloudflare Worker) ]
  ├── 📜 Rule Book Engine (Instant Triggers & AI Guidelines)
  ├── 🧠 Cloudflare Workers AI (Llama 4 Scout / Meta Neurons)
  ├── 🗄️ Cloudflare D1 Database (Chat History & Deduplication)
  └── 📦 Cloudflare R2 Bucket (Encrypted Session Backup)
       │
       ▼
[ Web Dashboard ]
  ├── 👑 Live Status & WhatsApp QR Scanner
  ├── 📜 Dedicated Rule Book (Instant Triggers & Guidelines)
  ├── 💬 Live Test Chat
  ├── 👥 Chat Histories & Management
  └── ⚙️ Model, Persona & Safety Settings
```

---

## 🚀 Key Features

* **100% Free Edge Compute:** Runs on Cloudflare's 10,000 free daily Neurons.
* **Instant Auto-Replies:** Keyword triggers respond in ~50ms with 0 Neurons consumed.
* **Smart AI Rules:** Behavioral rules strictly followed by the AI model.
* **Encrypted Cloud Persistence:** WhatsApp multi-device authentication is encrypted with AES-256-GCM and mirrored to Cloudflare R2, enabling seamless restarts without re-scanning QR codes.
* **Multi-Language:** Fluent in English, Bengali (বাংলা), and Banglish.
* **24/7 Cloud Operation:** Runs continuously in the cloud without requiring a local PC.

---

## 🛠️ Components

* `/worker`: Cloudflare Worker, Pages UI, D1 Database schema, and Workers AI integration.
* `/gateway`: WhatsApp multi-device gateway using Baileys and Cloudflare session sync.
* `/.github/workflows`: Continuous 24/7 cloud runner for GitHub Actions.
