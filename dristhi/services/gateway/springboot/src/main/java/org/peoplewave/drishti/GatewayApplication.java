package org.peoplewave.drishti;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * DRISHTI API Gateway (Spring Boot 3 / Java 21) — skeleton.
 * Mirrors the FastAPI gateway REST contract. Flesh out controllers, JPA
 * entities, and WebClient calls to the vision/seigniorage/omeps services.
 */
@SpringBootApplication
public class GatewayApplication {
    public static void main(String[] args) {
        SpringApplication.run(GatewayApplication.class, args);
    }
}
