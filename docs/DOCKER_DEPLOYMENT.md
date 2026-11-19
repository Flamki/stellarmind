# Docker Deployment Guide

## Overview

StellarMind provides production-ready Docker images with health checks, non-root user execution, and
persistent storage for run history.

## Default Configuration

### Port

The server defaults to **port 3001** in all environments:

- Local development: `http://localhost:3001`
- Docker container: exposed on `3001`
- Docker Compose: mapped to host port `3001`

### Health Check

The container includes a health check that probes `/healthz`:

- **Endpoint**: `GET /healthz`
- **Interval**: 30 seconds
- **Timeout**: 5 seconds
- **Start period**: 10 seconds
- **Retries**: 3

The `/healthz` endpoint returns:

```json
{
  "status": "ok",
  "uptime": 123.456,
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## Quick Start

### Using Docker Compose (Recommended)

1. **Prepare environment file:**

   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

2. **Start the services:**

   ```bash
   docker-compose up -d
   ```

3. **Check health status:**

   ```bash
   docker-compose ps
   ```

4. **Access the dashboard:**

   ```
   http://localhost:3001
   ```

5. **View logs:**

   ```bash
   docker-compose logs -f stellarmind
   ```

6. **Stop services:**

   ```bash
   docker-compose down
   ```

### Using Docker (Standalone)

1. **Build the image:**

   ```bash
   docker build -t stellarmind:latest .
   ```

2. **Run the container:**

   ```bash
   docker run -d \
     --name stellarmind \
     -p 3001:3001 \
     -e PORT=3001 \
     -e ANTHROPIC_API_KEY=sk-ant-... \
     -e SERVER_STELLAR_ADDRESS=G... \
     -e SERVER_STELLAR_SECRET=S... \
     -e ORCHESTRATOR_STELLAR_ADDRESS=G... \
     -e ORCHESTRATOR_STELLAR_SECRET=S... \
     -v stellarmind_data:/app/data \
     -v $(pwd)/logs:/app/logs \
     stellarmind:latest
   ```

3. **Check container health:**

   ```bash
   docker inspect stellarmind --format='{{.State.Health.Status}}'
   ```

4. **View logs:**

   ```bash
   docker logs -f stellarmind
   ```

## Port Configuration

### Default Port (3001)

No configuration needed. The server uses port 3001 by default.

**docker-compose.yml:**

```yaml
services:
  stellarmind:
    ports:
      - '3001:3001'
    environment:
      - PORT=3001
```

### Custom Port

Override the port by setting the `PORT` environment variable.

**Example: Port 8080**

**docker-compose.yml:**

```yaml
services:
  stellarmind:
    ports:
      - '8080:8080'
    environment:
      - PORT=8080
```

**Standalone Docker:**

```bash
docker run -d \
  --name stellarmind \
  -p 8080:8080 \
  -e PORT=8080 \
  --env-file .env \
  stellarmind:latest
```

**Verification:**

```bash
# Check health
curl http://localhost:8080/healthz

# Check status
curl http://localhost:8080/api/status
```

### Port Mapping Examples

| Use Case           | Host Port  | Container Port | Config                                          |
| ------------------ | ---------- | -------------- | ----------------------------------------------- |
| Default            | 3001       | 3001           | No change needed                                |
| Alternative        | 8080       | 8080           | `PORT=8080` + update ports mapping              |
| Behind proxy       | 80         | 3001           | Map `80:3001`, keep `PORT=3001`                 |
| Multiple instances | 3001, 3002 | 3001           | Map different host ports to same container port |

## Health Check Configuration

### Container Health Check

The Dockerfile includes a built-in health check that automatically uses the configured PORT:

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT:-3001}/healthz || exit 1
```

### Docker Compose Health Check

The docker-compose.yml overrides the health check for explicit configuration:

```yaml
healthcheck:
  test: ['CMD', 'wget', '--spider', 'http://localhost:3001/healthz']
  interval: 30s
  timeout: 5s
  retries: 3
  start_period: 10s
```

**For custom ports**, update the health check URL:

```yaml
healthcheck:
  test: ['CMD', 'wget', '--spider', 'http://localhost:8080/healthz']
```

### Checking Health Status

**Docker Compose:**

```bash
docker-compose ps
# Healthy containers show: "Up X minutes (healthy)"
```

**Standalone Docker:**

```bash
docker inspect stellarmind --format='{{.State.Health.Status}}'
# Output: "healthy", "unhealthy", or "starting"
```

**Detailed health check logs:**

```bash
docker inspect stellarmind --format='{{json .State.Health}}' | jq
```

**Manual health check:**

```bash
curl http://localhost:3001/healthz
```

## Persistent Storage

### Run History

The container stores orchestration run history in `/app/data/run-history.json`.

**Docker Compose** uses a named volume:

```yaml
volumes:
  - stellarmind_data:/app/data
```

**Standalone Docker** example with named volume:

```bash
docker run -d \
  --name stellarmind \
  -v stellarmind_data:/app/data \
  stellarmind:latest
```

**With host bind mount** (use with caution due to ownership issues):

```bash
# Create directory first
mkdir -p ./data
chmod 777 ./data  # Allow non-root container user to write

docker run -d \
  --name stellarmind \
  -v $(pwd)/data:/app/data \
  stellarmind:latest
```

### Logs

Map the logs directory to persist application logs:

```yaml
volumes:
  - ./logs:/app/logs
```

## Network Configuration

### Internal Base URL

The orchestrator needs to know its own URL for internal premium endpoint calls.

**Local development** (default):

```env
# Auto-configures to http://localhost:3001
INTERNAL_BASE_URL=
```

**Docker Compose** (container-to-container):

```env
INTERNAL_BASE_URL=http://stellarmind:3001
```

**Behind reverse proxy**:

```env
INTERNAL_BASE_URL=https://stellarmind.example.com
```

### Docker Compose Networks

Services communicate over the `stellarmind` bridge network:

```yaml
networks:
  stellarmind:
    driver: bridge
```

## Security

### Non-Root User

The container runs as the `stellarmind` user (UID 1001, GID 1001), not root.

### Secret Management

**Never commit secrets!** Use:

1. `.env` file (add to `.gitignore`)
2. Docker secrets (Swarm mode)
3. Environment variables from orchestrator
4. External secret managers (Vault, AWS Secrets Manager, etc.)

**Docker Compose with .env file:**

```yaml
env_file:
  - .env
```

**Docker secrets example (Swarm):**

```yaml
secrets:
  anthropic_key:
    external: true
  server_secret:
    external: true

services:
  stellarmind:
    secrets:
      - anthropic_key
      - server_secret
    environment:
      - ANTHROPIC_API_KEY_FILE=/run/secrets/anthropic_key
```

## Production Deployment

### Recommended Compose Configuration

```yaml
version: '3.8'

services:
  stellarmind:
    image: stellarmind:latest
    container_name: stellarmind
    restart: always
    ports:
      - '3001:3001'
    env_file:
      - .env
    environment:
      - NODE_ENV=production
      - PORT=3001
      - INTERNAL_BASE_URL=http://stellarmind:3001
    healthcheck:
      test: ['CMD', 'wget', '--spider', 'http://localhost:3001/healthz']
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    volumes:
      - stellarmind_data:/app/data
      - ./logs:/app/logs
    networks:
      - stellarmind
    logging:
      driver: json-file
      options:
        max-size: '10m'
        max-file: '3'

volumes:
  stellarmind_data:

networks:
  stellarmind:
    driver: bridge
```

### Behind a Reverse Proxy

**Nginx example:**

```nginx
upstream stellarmind {
    server localhost:3001;
}

server {
    listen 80;
    server_name stellarmind.example.com;

    location / {
        proxy_pass http://stellarmind;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Health check endpoint
    location /healthz {
        proxy_pass http://stellarmind/healthz;
        access_log off;
    }
}
```

**Traefik example:**

```yaml
services:
  stellarmind:
    labels:
      - 'traefik.enable=true'
      - 'traefik.http.routers.stellarmind.rule=Host(`stellarmind.example.com`)'
      - 'traefik.http.routers.stellarmind.entrypoints=websecure'
      - 'traefik.http.routers.stellarmind.tls.certresolver=letsencrypt'
      - 'traefik.http.services.stellarmind.loadbalancer.server.port=3001'
      - 'traefik.http.services.stellarmind.loadbalancer.healthcheck.path=/healthz'
```

## Troubleshooting

### Container Won't Start

**Check logs:**

```bash
docker-compose logs stellarmind
```

**Common issues:**

- Missing required environment variables (Stellar addresses, secrets)
- Port already in use: `docker ps` and check for conflicts
- Volume permission issues: ensure directories are writable

### Health Check Failing

**Manual test:**

```bash
curl http://localhost:3001/healthz
```

**If 404 error:**

- Check the health check is using `/healthz` not `/health`
- Verify PORT environment variable matches the mapped port

**If connection refused:**

- Server may not have started: check logs
- Wrong port configuration: verify PORT setting

**Check health check logs:**

```bash
docker inspect stellarmind --format='{{json .State.Health.Log}}' | jq
```

### Port Already in Use

**Find what's using the port:**

```bash
# Linux/macOS
lsof -i :3001

# Or using netstat
netstat -tuln | grep 3001
```

**Options:**

1. Stop the conflicting service
2. Use a different port (see Custom Port section)
3. Use Docker Compose profiles to avoid conflicts

### Permission Issues

If you see `EACCES` errors for `/app/data`:

**Verify ownership:**

```bash
docker exec stellarmind ls -la /app/data
```

**Should show:**

```
drwxr-xr-x 2 stellarmind stellarmind ...
```

**If using bind mounts** instead of named volumes:

```bash
mkdir -p ./data
chmod 777 ./data  # Or use proper UID/GID
```

## Validation Checklist

After deployment, verify:

- [ ] Container is running: `docker-compose ps`
- [ ] Container is healthy: `docker inspect stellarmind --format='{{.State.Health.Status}}'`
- [ ] Dashboard accessible: `http://localhost:3001`
- [ ] Health check responds: `curl http://localhost:3001/healthz`
- [ ] API status responds: `curl http://localhost:3001/api/status`
- [ ] Logs are being written: `docker-compose logs stellarmind`
- [ ] Run history persists after restart: `docker-compose restart stellarmind`

## Environment Variables Reference

| Variable                       | Required | Default                      | Description                    |
| ------------------------------ | -------- | ---------------------------- | ------------------------------ |
| `PORT`                         | No       | `3001`                       | Server HTTP port               |
| `NODE_ENV`                     | No       | `development`                | Environment mode               |
| `INTERNAL_BASE_URL`            | No       | `http://localhost:{PORT}`    | Base URL for internal calls    |
| `ANTHROPIC_API_KEY`            | Yes      | —                            | Anthropic API key              |
| `SERVER_STELLAR_ADDRESS`       | Yes      | —                            | Server wallet public key       |
| `SERVER_STELLAR_SECRET`        | Yes      | —                            | Server wallet secret key       |
| `ORCHESTRATOR_STELLAR_ADDRESS` | Yes      | —                            | Orchestrator wallet public key |
| `ORCHESTRATOR_STELLAR_SECRET`  | Yes      | —                            | Orchestrator wallet secret key |
| `RUN_HISTORY_FILE`             | No       | `/app/data/run-history.json` | Run history file path          |
| `LOG_FORMAT`                   | No       | `json`                       | Log format: `json` or `pretty` |

See [.env.example](.env.example) for complete list.

## See Also

- [README.md](../README.md) - Project overview and quick start
- [CONTRIBUTING.md](../CONTRIBUTING.md) - Development guidelines
- [.env.example](../.env.example) - Environment variable template
