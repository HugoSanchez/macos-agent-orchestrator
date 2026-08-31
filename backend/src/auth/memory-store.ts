import type {
  AppUserRecord,
  AuthStore,
  DeviceRecord,
  EntitlementRecord,
} from './types.ts';

export class MemoryAuthStore implements AuthStore {
  private readonly usersById = new Map<string, AppUserRecord>();
  private readonly usersByWorkOSUserId = new Map<string, string>();
  private readonly usersByEmail = new Map<string, string>();
  private readonly devicesById = new Map<string, DeviceRecord>();
  private readonly deviceLookup = new Map<string, string>();
  private readonly entitlementsById = new Map<string, EntitlementRecord>();

  async getUserByWorkOSUserId(workosUserId: string): Promise<AppUserRecord | null> {
    const id = this.usersByWorkOSUserId.get(workosUserId);
    return id ? this.usersById.get(id) ?? null : null;
  }

  async getUserByEmail(email: string): Promise<AppUserRecord | null> {
    const id = this.usersByEmail.get(email.toLowerCase());
    return id ? this.usersById.get(id) ?? null : null;
  }

  async insertUser(user: AppUserRecord): Promise<void> {
    this.usersById.set(user.id, { ...user });
    this.usersByWorkOSUserId.set(user.workosUserId, user.id);
    if (user.email) this.usersByEmail.set(user.email.toLowerCase(), user.id);
  }

  async updateUser(user: AppUserRecord): Promise<void> {
    const previous = this.usersById.get(user.id);
    if (previous?.workosUserId !== user.workosUserId) {
      this.usersByWorkOSUserId.delete(previous?.workosUserId ?? '');
    }
    if (previous?.email && previous.email.toLowerCase() !== user.email?.toLowerCase()) {
      this.usersByEmail.delete(previous.email.toLowerCase());
    }
    this.usersById.set(user.id, { ...user });
    this.usersByWorkOSUserId.set(user.workosUserId, user.id);
    if (user.email) this.usersByEmail.set(user.email.toLowerCase(), user.id);
  }

  async getDeviceByUserAndPlatform(userId: string, deviceLabel: string, platform: string): Promise<DeviceRecord | null> {
    const id = this.deviceLookup.get(deviceKey(userId, deviceLabel, platform));
    return id ? this.devicesById.get(id) ?? null : null;
  }

  async insertDevice(device: DeviceRecord): Promise<void> {
    this.devicesById.set(device.id, { ...device });
    this.deviceLookup.set(deviceKey(device.userId, device.deviceLabel, device.platform), device.id);
  }

  async updateDevice(device: DeviceRecord): Promise<void> {
    this.devicesById.set(device.id, { ...device });
    this.deviceLookup.set(deviceKey(device.userId, device.deviceLabel, device.platform), device.id);
  }

  async getUserById(userId: string): Promise<AppUserRecord | null> {
    return this.usersById.get(userId) ?? null;
  }

  async getDeviceById(deviceId: string): Promise<DeviceRecord | null> {
    return this.devicesById.get(deviceId) ?? null;
  }

  async listEntitlementsByUserId(userId: string): Promise<EntitlementRecord[]> {
    return Array.from(this.entitlementsById.values()).filter((item) => item.userId === userId);
  }

  async insertEntitlement(entitlement: EntitlementRecord): Promise<void> {
    this.entitlementsById.set(entitlement.id, { ...entitlement });
  }
}

function deviceKey(userId: string, deviceLabel: string, platform: string): string {
  return `${userId}::${deviceLabel}::${platform}`;
}
