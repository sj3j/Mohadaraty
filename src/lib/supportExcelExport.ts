import * as XLSX from 'xlsx';
import { PLAN_CONFIG, type SubscriptionPlan } from '../types';

export interface SupportSubscriptionExportRow {
  studentName?: string;
  studentEmail?: string;
  studentId?: string;
  plan?: string;
  amount?: number;
  createdAt?: string;
  paymentMethod?: string;
  referenceCode?: string;
  type?: string;
}

export const ARABIC_PLAN_LABELS: Record<string, string> = {
  ten_days: '10 أيام',
  monthly: 'شهري',
  seasonal: 'فصلي',
  semi_annual: 'نصف سنوي',
  annual: 'سنوي',
};

export const ARABIC_PAYMENT_LABELS: Record<string, string> = {
  cash: 'نقدي (كاش)',
  zaincash: 'زين كاش',
  superkey: 'سوبر كي',
  grant: 'منحة',
  admin_grant: 'منحة إدارية',
  other: 'أخرى',
  apple_iap: 'Apple IAP',
};

export function formatSubscriptionDate(dateVal?: string | null): string {
  if (!dateVal) return '—';
  try {
    const d = new Date(dateVal);
    if (isNaN(d.getTime())) return dateVal;
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  } catch {
    return dateVal;
  }
}

export function buildSupportSubscriptionsWorkbook(
  supportName: string,
  rows: SupportSubscriptionExportRow[],
): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();

  // Column Headers (Arabic only as approved)
  const headers = [
    'اسم المشترك',
    'نوع الاشتراك',
    'السعر',
    'تاريخ الاشتراك',
    'طريقة الدفع',
    'تم التدقيق',
  ];

  // Map rows to cell values
  const sheetData: any[][] = [headers];

  for (const row of rows) {
    const subscriberName = (row.studentName || row.studentEmail || row.studentId || '—').trim();
    const planKey = (row.plan || '').toLowerCase();
    const planLabel = ARABIC_PLAN_LABELS[planKey]
      || (planKey && PLAN_CONFIG[planKey as SubscriptionPlan]?.labelAr)
      || row.plan
      || '—';
    const price = Number.isFinite(row.amount) ? row.amount : 0;
    const formattedDate = formatSubscriptionDate(row.createdAt);
    const methodKey = (row.paymentMethod || '').toLowerCase();
    const paymentLabel = ARABIC_PAYMENT_LABELS[methodKey] || row.paymentMethod || '—';

    // The 6th column: visual checkbox box (Unicode Ballot Box '☐' \u2610)
    // Using '☐' ensures all versions of Excel (including Office 2021/2019/365) display a clean checkbox square
    // rather than the literal unclickable text "FALSE".
    sheetData.push([
      subscriberName,
      planLabel,
      price,
      formattedDate,
      paymentLabel,
      '☐',
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(sheetData);

  // Right-to-Left (RTL) spreadsheet orientation for Arabic
  ws['!views'] = [{ RTL: true }];

  // Auto-size column widths based on content
  ws['!cols'] = [
    { wch: 30 }, // اسم المشترك
    { wch: 18 }, // نوع الاشتراك
    { wch: 14 }, // السعر
    { wch: 20 }, // تاريخ الاشتراك
    { wch: 18 }, // طريقة الدفع
    { wch: 14 }, // تم التدقيق
  ];

  const safeSupportSheetName = (supportName || 'الموظف').replace(/[\\/?*[\]:]/g, '_').slice(0, 28);
  XLSX.utils.book_append_sheet(wb, ws, safeSupportSheetName || 'الاشتراكات');

  return wb;
}

export function downloadSupportSubscriptionsExcel(
  supportName: string,
  rows: SupportSubscriptionExportRow[],
  filterLabel: string = 'كشف_اشتراكات',
): void {
  const wb = buildSupportSubscriptionsWorkbook(supportName, rows);
  const now = new Date();
  const dateStamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const cleanName = (supportName || 'موظف_الدعم').replace(/\s+/g, '_').replace(/[\\/?*[\]:]/g, '');
  const cleanFilter = filterLabel.replace(/\s+/g, '_');
  const filename = `${cleanFilter}_${cleanName}_${dateStamp}.xlsx`;

  XLSX.writeFile(wb, filename);
}
