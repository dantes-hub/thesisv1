# Elder Labor Assistant (ELDERv1)

Accessible Retrieval-Augmented Generation (RAG) system for older adults in Taiwan.
Supports Chinese + English queries on labor insurance, pensions, and senior employment.

Features:
- Elder-friendly UI (large text, high-contrast, FAQ buttons)
- Trusted sources (Labor Insurance Bureau, regulations, pension info)
- Text-to-Speech (Mandarin + English)
- Qdrant vector search + OpenAI summarization


Setup Instructions

# 1. Clone
git clone https://github.com/dantes-hub/elderTWv1.git
cd elderv1

# 2. Install dependencies
npm install

# Install per-app deps
cd apps/frontend && npm install
cd ../retriever-api && npm install

# Python ingestion
cd ../../ingestion
pip install -r requirements.txt

# 3. Environment
# Create .env in root:
OPENAI_API_KEY=sk-...
ELEVENLABS_API_KEY=...

# Create .env in apps/retriever-api:
OPENAI_API_KEY=
QDRANT_URL=
ELEVENLABS_API_KEY=
TTS_VOICE_ZH=
TTS_VOICE_EN=
TTS_MODEL=

# 4. Run Qdrant
cd docker
docker compose up -d

# 5. Ingest data
cd ingestion
# put your CSV/JSON into ingestion/data
python ingest_labor.py

# 6. Start services
# Frontend
cd apps/frontend
npm run dev

# Retriever API
cd ../retriever-api
npm run dev

# Open in browser
http://localhost:3000

----------------------------------------------------------------------
Demo

Ask: 「我幾歲可以領勞保退休金？」

Get:
- Plain-language answer
- Checklist of steps
- Sources with links
- TTS playback

Print or save answers for later review.

----------------------------------------------------------------------
Disclaimer

This system is a prototype for research/competition.
It is not commercialized and not legal advice.
Please verify with the Bureau of Labor Insurance.
