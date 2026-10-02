/** Minimal HTTP surface the Traccar API needs (an axios instance satisfies it; tests pass a fake). */
export interface HttpClient {
  get<T>(url: string, config?: { params?: Record<string, unknown>; headers?: Record<string, string> }): Promise<{ data: T }>;
  post<T>(url: string, body: unknown): Promise<{ data: T }>;
  put<T>(url: string, body: unknown): Promise<{ data: T }>;
}

/** The Traccar device fields this feature reads; the full object is kept so PUT can send it back unchanged. */
export interface TraccarDeviceDto {
  id: number;
  name: string;
  uniqueId: string;
  groupId?: number | null;
  positionId?: number | null;
  lastUpdate?: string | null;
  [key: string]: unknown;
}

export interface TraccarPositionDto {
  id: number;
  deviceId: number;
  speed?: number | null;
  accuracy?: number | null;
  attributes?: { batteryLevel?: unknown; [key: string]: unknown };
}

export interface NewDevice {
  name: string;
  uniqueId: string;
  groupId: number;
}

export interface TraccarApi {
  /** Device with this uniqueId, or null when Traccar has none (e.g. it was deleted). */
  findDevice(uniqueId: string): Promise<TraccarDeviceDto | null>;
  /** Device by its Traccar id, or null when it doesn't exist. */
  getDevice(id: number): Promise<TraccarDeviceDto | null>;
  createDevice(device: NewDevice): Promise<TraccarDeviceDto>;
  /** PUT the full device object (Traccar replaces the whole record). */
  updateDevice(device: TraccarDeviceDto): Promise<TraccarDeviceDto>;
  /** A position by id (use the device's `positionId` for the latest one), or null. */
  getPosition(positionId: number): Promise<TraccarPositionDto | null>;
  /** Distance in metres from the summary report, or null when the report has no row. */
  getDistance(deviceId: number, from: Date, to: Date): Promise<number | null>;
}

export function createTraccarApi(http: HttpClient): TraccarApi {
  return {
    async findDevice(uniqueId) {
      const { data } = await http.get<TraccarDeviceDto[]>("/api/devices", { params: { uniqueId } });
      return data.find((device) => device.uniqueId === uniqueId) ?? null;
    },
    async getDevice(id) {
      const { data } = await http.get<TraccarDeviceDto[]>("/api/devices", { params: { id } });
      return data.find((device) => device.id === id) ?? null;
    },
    async createDevice(device) {
      const { data } = await http.post<TraccarDeviceDto>("/api/devices", device);
      return data;
    },
    async updateDevice(device) {
      const { data } = await http.put<TraccarDeviceDto>(`/api/devices/${device.id}`, device);
      return data;
    },
    async getPosition(positionId) {
      const { data } = await http.get<TraccarPositionDto[]>("/api/positions", { params: { id: positionId } });
      return data[0] ?? null;
    },
    async getDistance(deviceId, from, to) {
      const { data } = await http.get<{ deviceId: number; distance?: number }[]>("/api/reports/summary", {
        params: { deviceId, from: from.toISOString(), to: to.toISOString() },
        headers: { Accept: "application/json" },
      });
      const row = data.find((summary) => summary.deviceId === deviceId);
      return typeof row?.distance === "number" ? row.distance : null;
    },
  };
}
