import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { AuthService } from './auth.js';
import { AppStoreConnectConfig } from '../types/index.js';

export interface BinaryResponse {
  body: Buffer;
  headers: Record<string, string>;
  status: number;
}

export class AppStoreConnectClient {
  private axiosInstance: AxiosInstance;
  private authService: AuthService;

  constructor(config: AppStoreConnectConfig) {
    this.authService = new AuthService(config);
    this.authService.validateConfig();

    this.axiosInstance = axios.create({
      baseURL: 'https://api.appstoreconnect.apple.com/v1',
    });
  }

  async request<T = any>(method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH', url: string, data?: any, params?: Record<string, any>): Promise<T> {
    const token = await this.authService.generateToken();

    const response = await this.axiosInstance.request<T>({
      method,
      url,
      data,
      params,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    return response.data;
  }

  async get<T = any>(url: string, params?: Record<string, any>): Promise<T> {
    return this.request<T>('GET', url, undefined, params);
  }

  async post<T = any>(url: string, data: any): Promise<T> {
    return this.request<T>('POST', url, data);
  }

  async put<T = any>(url: string, data: any): Promise<T> {
    return this.request<T>('PUT', url, data);
  }

  async delete<T = any>(url: string, data?: any): Promise<T> {
    return this.request<T>('DELETE', url, data);
  }

  async patch<T = any>(url: string, data: any): Promise<T> {
    return this.request<T>('PATCH', url, data);
  }

  async downloadFromUrl(url: string): Promise<any> {
    const token = await this.authService.generateToken();

    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    return {
      data: response.data,
      contentType: response.headers['content-type'],
      size: response.headers['content-length']
    };
  }

  // First-party ASC endpoint, binary body (e.g. salesReports gzipped TSV).
  // Keeps the bearer token; returns raw bytes + headers so callers can read x-rate-limit etc.
  async getBinary(path: string, params?: Record<string, any>): Promise<BinaryResponse> {
    const token = await this.authService.generateToken();

    const response: AxiosResponse<ArrayBuffer> = await this.axiosInstance.request({
      method: 'GET',
      url: path,
      params,
      responseType: 'arraybuffer',
      // Treat 404 as a resolved response so callers can inspect the body
      // (salesReports returns 404 with a message body when no data exists).
      validateStatus: (status) => (status >= 200 && status < 300) || status === 404,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/a-gzip, application/octet-stream, */*',
      }
    });

    return {
      body: Buffer.from(response.data),
      headers: normalizeHeaders(response.headers),
      status: response.status,
    };
  }

  // Segment pre-signed S3 URL: do NOT attach the ASC bearer — AWS will reject it.
  // Returns the gzipped bytes as-is.
  async downloadBinaryPublic(url: string): Promise<BinaryResponse> {
    const response: AxiosResponse<ArrayBuffer> = await axios.get(url, {
      responseType: 'arraybuffer',
    });

    return {
      body: Buffer.from(response.data),
      headers: normalizeHeaders(response.headers),
      status: response.status,
    };
  }
}

function normalizeHeaders(raw: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (v == null) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : String(v);
  }
  return out;
}
