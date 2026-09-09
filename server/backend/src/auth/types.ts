export interface WorkOSUserIdentity {
  id: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
}

export interface VerifiedWorkOSAccessToken {
  userId: string;
  sessionId: string;
  issuedAt: number;
  expiration: number;
}

export interface WorkOSAuthenticationResult {
  accessToken: string;
  refreshToken: string;
  user: WorkOSUserIdentity;
}

export interface WorkOSAuthProvider {
  sendMagicCode(input: {
    email: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<void>;
  authenticateMagicCode(input: {
    email: string;
    code: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<WorkOSAuthenticationResult>;
  refreshSession(input: {
    refreshToken: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<WorkOSAuthenticationResult>;
  verifyAccessToken(accessToken: string): Promise<VerifiedWorkOSAccessToken>;
  revokeSession(sessionId: string): Promise<void>;
}

export interface AppUserRecord {
  id: string;
  workosUserId: string;
  email: string | null;
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceRecord {
  id: string;
  userId: string;
  deviceLabel: string;
  platform: string;
  lastSeenAt: string;
  createdAt: string;
}

export interface AuthenticatedSession {
  id: string;
  issuedAt: string;
  expiresAt: string;
}

export interface EntitlementRecord {
  id: string;
  userId: string;
  mode: string;
  status: string;
  monthlyUsdLimit: string | null;
  dailyUsdLimit: string | null;
  allowedModels: string[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthenticatedContext {
  user: AppUserRecord;
  device: DeviceRecord;
  session: AuthenticatedSession;
  entitlements: EntitlementRecord[];
}

export interface AuthStore {
  getUserByWorkOSUserId(workosUserId: string): Promise<AppUserRecord | null>;
  getUserByEmail(email: string): Promise<AppUserRecord | null>;
  insertUser(user: AppUserRecord): Promise<void>;
  updateUser(user: AppUserRecord): Promise<void>;
  getDeviceByUserAndPlatform(userId: string, deviceLabel: string, platform: string): Promise<DeviceRecord | null>;
  insertDevice(device: DeviceRecord): Promise<void>;
  updateDevice(device: DeviceRecord): Promise<void>;
  getUserById(userId: string): Promise<AppUserRecord | null>;
  getDeviceById(deviceId: string): Promise<DeviceRecord | null>;
  listEntitlementsByUserId(userId: string): Promise<EntitlementRecord[]>;
  insertEntitlement(entitlement: EntitlementRecord): Promise<void>;
}
