Assignment 1 - REST API Project - Response to Criteria

**Name:** Karan Singh Sandhu  
**Student number:** n11845619  

# Response to marking criteria  

---

## Core: CPU-intensive task (3 marks)

- **One line description:** API-triggered video generation (PDF→images, LLM script, TTS, ffmpeg with 2-pass encode + motion interpolation) that drives sustained high CPU.  
- **Video timestamp:** 01:03 – 02:46 
- **Relevant files**
  - /src/routes/jobs.js  
  - /src/utils/tts.js  
  - /Dockerfile  

## Core: CPU load testing (2 marks)

- **One line description:** Parallel job submissions (via Postman Runner) sustain >80% CPU for ≥5 minutes; verified in htop and CloudWatch.  
- **Video timestamp:** 01:45 – 02:46  
- **Relevant files**
  - /src/routes/jobs.js (workload endpoint)  
  - /docker-compose.yaml (runs worker + ollama)  

## Core: Data types (3 marks)

- **One line description:** Stores **unstructured** media (PDFs, PNG slides, WAV narration, MP4 outputs, VTT captions) and **structured** rows (assets/jobs) in SQLite.  
- **Video timestamp:** 1:25 – 1:32 (upload/list), 2:47 – 3:00 (finished job output)  
- **Relevant files**
  - /src/routes/assets.js  
  - /src/routes/jobs.js  
  - /data/** (runtime artifacts)  

## Core: Containerise the app (3 marks)

- **One line description:** Built a Docker image and pushed to AWS ECR.  
- **Video timestamp:** 00:05 – 00:30 (ECR repo + tag)  
- **Relevant files**
  - /Dockerfile  

## Core: Deploy the container (3 marks)

- **One line description:** Pulled from ECR and ran on EC2 using Docker Compose (api + ollama, persistent volumes, shared network).  
- **Video timestamp:** 00:18 – 00:31  
- **Relevant files**
  - /docker-compose.yaml  

## Core: REST API (3 marks)

- **One line description:** Primary interface exposes assets (upload/list/get/delete) and jobs (create/list/get/logs/output) with pagination, filtering, sorting, and Range downloads.  
- **Video timestamp:** 1:10 – 01:52 (login + endpoints), 03:10 – 03:20 (logs/output)  
- **Relevant files**
  - /src/routes/assets.js  
  - /src/routes/jobs.js  

## Core: User login (3 marks)

- **One line description:** Basic JWT auth with hard-coded users; per-user scoping ensures users only see their own assets/jobs.  
- **Video timestamp:** 01:15 – 01:23  
- **Relevant files**
  - /src/routes/auth.js  

---

## Additional: Extended API features (2.5 marks)

- **One line description:** Pagination (`limit/offset`), sorting (`sort` asc/desc), filtering (e.g., `status`, `type`), and list metadata (`total`, `page`, `pageCount`); Range/206 on downloads.  
- **Video timestamp:** 01:34 – 01:44  
- **Relevant files**
  - /src/routes/assets.js  
  - /src/routes/jobs.js  

## Additional: External APIs (2.5 marks)

- **One line description:** Wikipedia enrichment endpoint summarizes and blends context into script prompts (not a simple proxy).  
- **Video timestamp:** 03:22 – 03:42 
- **Relevant files**
  - /src/utils/wiki.js  
  - /src/routes/jobs.js (integration point)  

## Additional: Infrastructure as code (2.5 marks)

- **One line description:** Docker Compose defines services, volumes, networks, env; reproducible pull-and-run from ECR on EC2.  
- **Video timestamp:** 03:43 – 03:58  
- **Relevant files**
  - /docker-compose.yaml  

## Additional: Custom processing (2.5 marks)

- **One line description:** Custom pipeline steps: script cleaning for TTS, duet handling, duration-aware prompting, VTT generation (sidecar), minterpolate, and 2-pass encode profiles (`balanced|heavy|insane`).  
- **Video timestamp:** 04:01 – 04:15  
- **Relevant files**
  - /src/routes/jobs.js  
  - /src/utils/tts.js  

---
