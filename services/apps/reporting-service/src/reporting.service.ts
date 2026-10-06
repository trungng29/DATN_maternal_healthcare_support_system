import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import {
  RabbitMqConsumer,
  type DomainEventEnvelope,
  dateToTimestamp,
} from '@platform';
import { AppPrismaService } from './database/prisma.service';

@Injectable()
export class ReportingService implements OnModuleInit {
  constructor(
    private readonly db: AppPrismaService,
    private readonly mq: RabbitMqConsumer,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.get('RABBITMQ_URL')) return;
    await this.mq.subscribe({
      queue: 'maternal.reporting.projection.v1',
      routingKeys: [
        'appointment.*',
        'billing.payment_recorded.v1',
        'queue.*',
        'medical.*',
      ],
      handler: (event) => this.consume(event),
    });
  }

  async consume(event: DomainEventEnvelope): Promise<void> {
    if (await this.db.consumedEvent.findUnique({ where: { eventId: event.eventId } })) return;
    const occurredAt = new Date(event.occurredAt);
    const businessDate = new Date(Date.UTC(
      occurredAt.getUTCFullYear(),
      occurredAt.getUTCMonth(),
      occurredAt.getUTCDate(),
    ));
    const reportType = event.eventType.startsWith('billing')
      ? 'REVENUE_DAILY'
      : 'APPOINTMENT_DAILY';
    await this.db.$transaction(async (tx) => {
      await tx.consumedEvent.create({
        data: {
          eventId: event.eventId,
          eventType: event.eventType,
          occurredAt,
          payloadHash: createHash('sha256').update(JSON.stringify(event)).digest('hex'),
        },
      });
      const key = { businessDate, reportType, dimensionKey: 'ALL' };
      const old = await tx.dailyMetric.findUnique({
        where: { businessDate_reportType_dimensionKey: key },
      });
      const measures = { ...((old?.measures ?? {}) as Record<string, number>) };
      measures.total = Number(measures.total ?? 0) + 1;
      if (event.eventType === 'appointment.completed.v1') measures.completed = Number(measures.completed ?? 0) + 1;
      if (event.eventType === 'appointment.cancelled.v1') measures.cancelled = Number(measures.cancelled ?? 0) + 1;
      if (event.eventType === 'billing.payment_recorded.v1') {
        measures.collected = Number(measures.collected ?? 0) + Number((event.data as Record<string, unknown>).amountMinor ?? 0);
      }
      await tx.dailyMetric.upsert({
        where: { businessDate_reportType_dimensionKey: key },
        create: { ...key, dimensions: {}, measures },
        update: { measures, version: { increment: 1 } },
      });
    });
  }

  rows(type: string, from: string, to: string) {
    return this.db.dailyMetric.findMany({
      where: {
        reportType: type,
        businessDate: { gte: new Date(from), lte: new Date(to) },
      },
      orderBy: { businessDate: 'asc' },
    });
  }

  async overview(request: any) {
    const rows = await this.rows('APPOINTMENT_DAILY', request.period.fromDate, request.period.toDate);
    const revenue = await this.rows('REVENUE_DAILY', request.period.fromDate, request.period.toDate);
    const sum = (items: Array<{ measures: unknown }>, field: string) =>
      items.reduce(
        (total, item) =>
          total +
          Number((item.measures as Record<string, unknown>)[field] ?? 0),
        0,
      );
    return {
      period: request.period,
      totalAppointments: String(sum(rows, 'total')),
      completedAppointments: String(sum(rows, 'completed')),
      cancelledAppointments: String(sum(rows, 'cancelled')),
      totalCollectedAmount: String(sum(revenue, 'collected')),
      currency: 'VND',
      projection: {
        projectedAt: dateToTimestamp(new Date()),
        dataThrough: dateToTimestamp(new Date()),
      },
    };
  }

  async csv(type: string, period: any) {
    const rows = await this.rows(type, period.fromDate, period.toDate);
    const newline = String.fromCharCode(10);
    const header = 'date,total,completed,cancelled,collected';
    const body = rows.map((item) => {
      const measures = item.measures as Record<string, number>;
      return [
        item.businessDate.toISOString().slice(0, 10),
        measures.total ?? 0,
        measures.completed ?? 0,
        measures.cancelled ?? 0,
        measures.collected ?? 0,
      ].join(',');
    });
    return {
      content: Buffer.from([header, ...body].join(newline)),
      contentType: 'text/csv',
      filename: type.toLowerCase() + '.csv',
      generatedAt: dateToTimestamp(new Date()),
    };
  }
}
