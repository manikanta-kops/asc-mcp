import { AppStoreConnectClient } from '../services/index.js';
import {
  AnalyticsReportRequest,
  AnalyticsReportRequestResponse,
  ListAnalyticsReportsResponse,
  ListAnalyticsReportSegmentsResponse,
  ListAnalyticsReportInstancesResponse,
  AnalyticsReport,
  AnalyticsAccessType,
  AnalyticsReportCategory,
  AnalyticsReportGranularity,
  SalesReportResponse,
  FinanceReportResponse,
  SalesReportType,
  SalesReportSubType,
  SalesReportFrequency,
  SalesReportFilters,
  FinanceReportFilters
} from '../types/index.js';
import { validateRequired, sanitizeLimit, buildFilterParams } from '../utils/index.js';

export class AnalyticsHandlers {
  constructor(private client: AppStoreConnectClient, private config?: { vendorNumber?: string }) {}

  async createAnalyticsReportRequest(args: {
    appId: string;
    accessType?: AnalyticsAccessType;
  }): Promise<AnalyticsReportRequestResponse> {
    const { appId, accessType = "ONE_TIME_SNAPSHOT" } = args;
    
    validateRequired(args, ['appId']);

    const requestBody: AnalyticsReportRequest = {
      data: {
        type: "analyticsReportRequests",
        attributes: {
          accessType
        },
        relationships: {
          app: {
            data: {
              id: appId,
              type: "apps"
            }
          }
        }
      }
    };

    return this.client.post<AnalyticsReportRequestResponse>('/analyticsReportRequests', requestBody);
  }

  async listAnalyticsReports(args: {
    reportRequestId: string;
    limit?: number;
    filter?: {
      category?: AnalyticsReportCategory;
    };
  }): Promise<ListAnalyticsReportsResponse> {
    const { reportRequestId, limit = 100, filter } = args;

    validateRequired(args, ['reportRequestId']);

    const params: Record<string, any> = {
      limit: sanitizeLimit(limit)
    };

    Object.assign(params, buildFilterParams(filter));

    return this.client.get<ListAnalyticsReportsResponse>(`/analyticsReportRequests/${reportRequestId}/reports`, params);
  }

  // Pagination-aware variant: follows `links.next` until exhausted.
  // Safe cap of 10 pages to prevent runaway loops if Apple ever returns a cycle.
  async listAllAnalyticsReports(args: {
    reportRequestId: string;
    filter?: {
      category?: AnalyticsReportCategory;
    };
    pageSize?: number;
  }): Promise<AnalyticsReport[]> {
    const { reportRequestId, filter, pageSize = 200 } = args;
    validateRequired(args, ['reportRequestId']);

    const out: AnalyticsReport[] = [];
    let next: string | undefined;
    let firstParams: Record<string, any> = {
      limit: sanitizeLimit(pageSize, 200),
      ...buildFilterParams(filter),
    };

    for (let page = 0; page < 10; page++) {
      let response: ListAnalyticsReportsResponse;
      if (page === 0) {
        response = await this.client.get<ListAnalyticsReportsResponse>(
          `/analyticsReportRequests/${reportRequestId}/reports`,
          firstParams,
        );
      } else if (next) {
        // Apple's next link is an absolute URL; use the client's raw request against it.
        response = await this.client.request<ListAnalyticsReportsResponse>('GET', next);
      } else {
        break;
      }

      if (Array.isArray(response.data)) out.push(...response.data);
      next = response.links?.next;
      if (!next) break;
    }

    return out;
  }

  async listAnalyticsReportSegments(args: {
    reportId: string;
    limit?: number;
  }): Promise<ListAnalyticsReportSegmentsResponse> {
    const { reportId, limit = 100 } = args;

    validateRequired(args, ['reportId']);

    return this.client.get<ListAnalyticsReportSegmentsResponse>(`/analyticsReports/${reportId}/segments`, {
      limit: sanitizeLimit(limit)
    });
  }

  // Instance-keyed: pick the day you want, then list that instance's segments.
  // This is the correct path for "get 2026-04-22's data"; the report-keyed variant
  // above returns segments across all dates and can't target one.
  async listAnalyticsReportInstances(args: {
    reportId: string;
    granularity?: AnalyticsReportGranularity;
    processingDate?: string; // "YYYY-MM-DD"
    limit?: number;
  }): Promise<ListAnalyticsReportInstancesResponse> {
    const { reportId, granularity, processingDate, limit = 200 } = args;

    validateRequired(args, ['reportId']);

    const params: Record<string, any> = {
      limit: sanitizeLimit(limit, 200),
      ...buildFilterParams({ granularity, processingDate }),
    };

    return this.client.get<ListAnalyticsReportInstancesResponse>(
      `/analyticsReports/${reportId}/instances`,
      params,
    );
  }

  async listSegmentsForInstance(args: {
    instanceId: string;
    limit?: number;
  }): Promise<ListAnalyticsReportSegmentsResponse> {
    const { instanceId, limit = 200 } = args;

    validateRequired(args, ['instanceId']);

    return this.client.get<ListAnalyticsReportSegmentsResponse>(
      `/analyticsReportInstances/${instanceId}/segments`,
      { limit: sanitizeLimit(limit, 200) },
    );
  }

  async downloadAnalyticsReportSegment(args: {
    segmentUrl: string;
  }): Promise<{ data: any; contentType: string; size: string }> {
    const { segmentUrl } = args;
    
    validateRequired(args, ['segmentUrl']);

    return this.client.downloadFromUrl(segmentUrl);
  }

  async downloadSalesReport(args: {
    vendorNumber?: string;
    reportType?: SalesReportType;
    reportSubType?: SalesReportSubType;
    frequency?: SalesReportFrequency;
    reportDate: string;
  }): Promise<SalesReportResponse> {
    const { 
      vendorNumber = this.config?.vendorNumber, 
      reportType = "SALES", 
      reportSubType = "SUMMARY", 
      frequency = "MONTHLY", 
      reportDate 
    } = args;
    
    if (!vendorNumber) {
      throw new Error('Vendor number is required. Please provide it as an argument or set APP_STORE_CONNECT_VENDOR_NUMBER environment variable.');
    }
    
    validateRequired({ reportDate }, ['reportDate']);

    const filters: SalesReportFilters = {
      reportDate,
      reportType,
      reportSubType,
      frequency,
      vendorNumber
    };

    return this.client.get<SalesReportResponse>('/salesReports', buildFilterParams(filters));
  }

  async downloadFinanceReport(args: {
    vendorNumber?: string;
    reportDate: string;
    regionCode: string;
  }): Promise<FinanceReportResponse> {
    const { vendorNumber = this.config?.vendorNumber, reportDate, regionCode } = args;
    
    if (!vendorNumber) {
      throw new Error('Vendor number is required. Please provide it as an argument or set APP_STORE_CONNECT_VENDOR_NUMBER environment variable.');
    }
    
    validateRequired({ reportDate, regionCode }, ['reportDate', 'regionCode']);

    const filters: FinanceReportFilters = {
      reportDate,
      regionCode,
      vendorNumber
    };

    return this.client.get<FinanceReportResponse>('/financeReports', buildFilterParams(filters));
  }
}