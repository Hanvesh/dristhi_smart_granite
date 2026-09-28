# Gateway — Spring Boot 3 / Java 21 (alternative path)

The proposal specifies a Java 21 + Spring Boot 3 gateway. The runnable default
gateway in the parent folder is FastAPI (zero extra prerequisites for the demo).
This folder holds the equivalent Spring Boot skeleton so a team can switch to the
JVM stack while keeping the **same REST contract**:

```
GET  /health
GET  /blocks
GET  /blocks/{id}
POST /blocks/{id}/approve
POST /blocks/{id}/flag
POST /captures
POST /omeps/sync/{id}
GET  /analytics/summary
GET  /robots
POST /robots/{id}/survey
POST /robots/{id}/survey/stop
```

## Build & run
```bash
mvn spring-boot:run          # needs JDK 21 + Maven
```

## Security
`SecurityConfig` wires Keycloak as an OAuth2 resource server (JWT). Point
`spring.security.oauth2.resourceserver.jwt.issuer-uri` at
`http://localhost:8090/realms/drishti`. Map realm roles
(`operator`, `officer`, `admin`, `robot-operator`) to method-level `@PreAuthorize`.

Persistence uses Spring Data JPA against the same PostgreSQL+PostGIS schema in
`infra/init/db`. Downstream calls to the vision/seigniorage/omeps services use
`WebClient`.
