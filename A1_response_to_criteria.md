Assignment 1 - REST API Project - Response to Criteria
================================================

Overview
------------------------------------------------

- **Name:** Karan Singh Sandhu  
- **Student number:** n11845619  
- **Application name:** NoteFlix – Lecture‑to‑Video REST API  
- **Two line description:** A Dockerised backend that turns lecture PDFs into narrated videos through a CPU‑heavy pipeline (PDF→images → LLM script → TTS → ffmpeg). Exposes authenticated REST endpoints for assets, jobs, logs, and outputs with pagination, filters, and ranged downloads.

Core criteria
------------------------------------------------

### Containerise the app

- **ECR Repository name:** *(shown in video; same repo used to push the built image)*  
- **Video timestamp:** 00:21 – 00:37
- **Relevant files:**
    - `/Dockerfile`

### Deploy the container

- **EC2 instance ID:** *(shown in video when connecting to host)*  
- **Video timestamp:** 00:38 – 01:08

### User login

- **One line description:** Basic JWT auth with hard‑coded users; per‑user scoping so users only see their own assets/jobs.  
- **Video timestamp:** 01:20 – 01:29  
- **Relevant files:**
    - `/src/routes/auth.js`

### REST API

- **One line description:** Assets (upload/list/get/delete) and Jobs (create/list/get/logs/output) with pagination, filtering, sorting, and HTTP Range downloads for large files.  
- **Video timestamp:** 01:20 – 01:59 (login + endpoints), 02:58 – 03:25 (logs/output)  
- **Relevant files:**
    - `/src/routes/assets.js`  
    - `/src/routes/jobs.js`

### Data types

- **One line description:** Persists both **structured** rows (assets/jobs in SQLite) and **unstructured** media artifacts (PDFs, PNG slides, WAV narration, MP4 outputs, VTT captions).  
- **Video timestamp:** 01:30 – 01:39 (upload/list), 02:58 – 03:07 (finished job output)  
- **Relevant files:**
    - `/src/routes/assets.js`  
    - `/src/routes/jobs.js`  
    - `/data/**` (runtime artifacts)

#### First kind

- **One line description:** Asset and job metadata stored for listing, filtering, and pagination.  
- **Type:** Structured (relational rows)  
- **Rationale:** Enables efficient queries (status/type/user), ordering, and paging; supports multi‑user scoping.  
- **Video timestamp:** 01:30 – 01:39  
- **Relevant files:**
    - `/src/routes/assets.js`  
    - `/src/routes/jobs.js`

#### Second kind

- **One line description:** Media artifacts generated/consumed by the pipeline (PDF/PNG/WAV/MP4/VTT).  
- **Type:** Unstructured (binary files)  
- **Rationale:** Large media blobs are stored on disk with Range/206 support for downloads and streaming.  
- **Video timestamp:** 02:58 – 03:07  
- **Relevant files:**
  - `/src/routes/assets.js`  
  - `/src/routes/jobs.js`  
  - `/data/**`

### CPU intensive task

- **One line description:** API‑triggered video generation (PDF→images, script, TTS, ffmpeg with 2‑pass encode + `minterpolate`) sustaining high CPU utilisation.  
- **Video timestamp:** 02:00 – 02:23  
- **Relevant files:**
    - `/src/routes/jobs.js`  
    - `/src/utils/tts.js`  
    - `/Dockerfile`

### CPU load testing

- **One line description:** Parallel job submissions (Postman Runner) keep CPU >80% for ≥5 minutes; verified with `htop` and CloudWatch.  
- **Video timestamp:** 02:23 – 02:53  
- **Relevant files:**
    - `/src/routes/jobs.js` (workload endpoint)  
    - `/docker-compose.yaml` (runs worker + ollama)

Additional criteria
------------------------------------------------

### Extensive REST API features

- **One line description:** Pagination (`limit/offset`), sorting (`sort` asc/desc), filtering (`status`, `type`), list metadata (`total`, `page`, `pageCount`), and Range/206 downloads.  
- **Video timestamp:** 01:40 – 01:50  
- **Relevant files:**
    - `/src/routes/assets.js`  
    - `/src/routes/jobs.js`

### External API(s)

- **One line description:** Wikipedia enrichment endpoint summarises and blends context into script prompts (not a simple proxy).  
- **Video timestamp:** 03:29 – 03:49  
- **Relevant files:**
    - `/src/utils/wiki.js`  
    - `/src/routes/jobs.js` (integration point)


### Custom processing

- **One line description:** Script cleaning for TTS, duet handling, duration‑aware prompting, VTT (sidecar) generation, ffmpeg `minterpolate`, and 2‑pass encode profiles (`balanced | heavy | insane`).  
- **Video timestamp:** 04:04 – 04:23  
- **Relevant files:**
    - `/src/routes/jobs.js`  
    - `/src/utils/tts.js`

### Infrastructure as code

- **One line description:** Docker Compose defines services, volumes, networks, and env for reproducible pull‑and‑run from ECR on EC2.  
- **Video timestamp:** 03:49 – 04:04  
- **Relevant files:**
    - `/docker-compose.yaml`
