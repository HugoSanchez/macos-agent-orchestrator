import { and, eq, sql } from 'drizzle-orm';
import { getDb } from './client.ts';
import { devices, entitlements, users } from './schema.ts';
import type {
  AppUserRecord,
  AuthStore,
  DeviceRecord,
  EntitlementRecord,
} from '../auth/types.ts';

type Db = ReturnType<typeof getDb>;

export class DrizzleAuthStore implements AuthStore {
  private readonly db: Db;

  constructor(databaseUrl: string) {
    this.db = getDb(databaseUrl);
  }

  async getUserByWorkOSUserId(workosUserId: string): Promise<AppUserRecord | null> {
    const rows = await this.db.select().from(users).where(eq(users.workosUserId, workosUserId)).limit(1);
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async getUserByEmail(email: string): Promise<AppUserRecord | null> {
    const rows = await this.db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
      .limit(1);
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async insertUser(user: AppUserRecord): Promise<void> {
    await this.db.insert(users).values(serializeUser(user));
  }

  async updateUser(user: AppUserRecord): Promise<void> {
    await this.db
      .update(users)
      .set({
        workosUserId: user.workosUserId,
        email: user.email,
        displayName: user.displayName,
        updatedAt: new Date(user.updatedAt),
      })
      .where(eq(users.id, user.id));
  }

  async getDeviceByUserAndPlatform(
    userId: string,
    deviceLabel: string,
    platform: string,
  ): Promise<DeviceRecord | null> {
    const rows = await this.db
      .select()
      .from(devices)
      .where(and(
        eq(devices.userId, userId),
        eq(devices.deviceLabel, deviceLabel),
        eq(devices.platform, platform),
      ))
      .limit(1);
    return rows[0] ? mapDevice(rows[0]) : null;
  }

  async insertDevice(device: DeviceRecord): Promise<void> {
    await this.db.insert(devices).values(serializeDevice(device));
  }

  async updateDevice(device: DeviceRecord): Promise<void> {
    await this.db
      .update(devices)
      .set({
        deviceLabel: device.deviceLabel,
        platform: device.platform,
        lastSeenAt: new Date(device.lastSeenAt),
      })
      .where(eq(devices.id, device.id));
  }

  async getUserById(userId: string): Promise<AppUserRecord | null> {
    const rows = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async getDeviceById(deviceId: string): Promise<DeviceRecord | null> {
    const rows = await this.db.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
    return rows[0] ? mapDevice(rows[0]) : null;
  }

  async listEntitlementsByUserId(userId: string): Promise<EntitlementRecord[]> {
    const rows = await this.db.select().from(entitlements).where(eq(entitlements.userId, userId));
    return rows.map(mapEntitlement);
  }

  async insertEntitlement(entitlement: EntitlementRecord): Promise<void> {
    await this.db.insert(entitlements).values(serializeEntitlement(entitlement));
  }
}

type UserRow = typeof users.$inferSelect;
type DeviceRow = typeof devices.$inferSelect;
type EntitlementRow = typeof entitlements.$inferSelect;

function mapUser(row: UserRow): AppUserRecord {
  return {
    id: row.id,
    workosUserId: row.workosUserId,
    email: row.email,
    displayName: row.displayName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeUser(record: AppUserRecord): typeof users.$inferInsert {
  return {
    id: record.id,
    workosUserId: record.workosUserId,
    email: record.email,
    displayName: record.displayName,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

function mapDevice(row: DeviceRow): DeviceRecord {
  return {
    id: row.id,
    userId: row.userId,
    deviceLabel: row.deviceLabel,
    platform: row.platform,
    lastSeenAt: row.lastSeenAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function serializeDevice(record: DeviceRecord): typeof devices.$inferInsert {
  return {
    id: record.id,
    userId: record.userId,
    deviceLabel: record.deviceLabel,
    platform: record.platform,
    lastSeenAt: new Date(record.lastSeenAt),
    createdAt: new Date(record.createdAt),
  };
}

function mapEntitlement(row: EntitlementRow): EntitlementRecord {
  return {
    id: row.id,
    userId: row.userId,
    mode: row.mode,
    status: row.status,
    monthlyUsdLimit: row.monthlyUsdLimit,
    dailyUsdLimit: row.dailyUsdLimit,
    allowedModels: row.allowedModels,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeEntitlement(record: EntitlementRecord): typeof entitlements.$inferInsert {
  return {
    id: record.id,
    userId: record.userId,
    mode: record.mode,
    status: record.status,
    monthlyUsdLimit: record.monthlyUsdLimit,
    dailyUsdLimit: record.dailyUsdLimit,
    allowedModels: record.allowedModels,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}
