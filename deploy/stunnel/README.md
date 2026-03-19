# Stunnel Cert Layout

The production stack expects mutual-TLS files for the internal `stunnel` hop between the gateway and vector store.

Set `STUNNEL_CERTS_DIR` in your production environment to a private directory on the server, for example:

```bash
STUNNEL_CERTS_DIR=/srv/atlasrag/stunnel-certs
```

That directory should contain:

- `ca.crt`
- `client.crt`
- `client.key`
- `server.crt`
- `server.key`

These filenames are referenced by:

- `deploy/stunnel/vector-client.conf`
- `deploy/stunnel/vector-server.conf`

## Notes

- Do not commit real certificate or key material to the repository.
- Keep this directory readable by the deployment user and mount it read-only into the containers.
- The current `docker-compose.prod.yml` keeps a backward-compatible fallback to `./deploy/certs` when `STUNNEL_CERTS_DIR` is unset. For public/open-source use, the external directory is the recommended path.
