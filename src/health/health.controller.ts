// src/health/health.controller.ts
import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '@common/guards/api-key.guard';
import { DatabaseService } from '@database/database.service';

interface HealthResponse {
  status: 'ok' | 'error';
  timestamp: string;
  uptime: number;
  database: { connected: boolean; version?: string };
}

@ApiTags('health')
@Public() // ← no API key needed for health checks
@SkipThrottle() // ← orchestrator liveness/readiness probes poll frequently
@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  @ApiOperation({ summary: 'System health check' })
  async check(): Promise<HealthResponse> {
    const dbHealthy = await this.db.isHealthy();
    const dbVersion = dbHealthy ? await this.db.getPostgresVersion() : undefined;
    return {
      status: dbHealthy ? 'ok' : 'error',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: { connected: dbHealthy, version: dbVersion ?? '' },
    };
  }
}
