import { Workbook } from 'exceljs';
import JSZip from 'jszip';

/** Store text inline so spreadsheet previews cannot mistake string indexes for data. */
export async function serializeLeadsWorkbook(workbook: Workbook): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await workbook.xlsx.writeBuffer());
  const shared = await zip.file('xl/sharedStrings.xml')?.async('string');
  if (shared) {
    const strings = Array.from(shared.matchAll(/<si>([\s\S]*?)<\/si>/g), (match) => match[1]);
    for (const path of Object.keys(zip.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))) {
      const xml = await zip.file(path)!.async('string');
      zip.file(path, xml.replace(/<c\b([^>]*?)\bt="s"([^>]*)><v>(\d+)<\/v><\/c>/g,
        (_match, before: string, after: string, index: string) => {
          const value = strings[Number(index)];
          if (value === undefined) throw new Error('Invalid spreadsheet string reference');
          return `<c${before}t="inlineStr"${after}><is>${value}</is></c>`;
        }));
    }
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

type ExportRow = Record<string, unknown>;

const columns = [
  ['nome', 'Nome', 34], ['telefone', 'Telefone', 22], ['email', 'E-mail', 36],
  ['created_at', 'Data de entrada', 23], ['pipeline', 'Funil', 28],
  ['stage', 'Etapa', 28], ['responsavel', 'Responsável', 28],
  ['temperatura', 'Temperatura', 18], ['valor_estimado', 'Valor estimado', 22],
  ['tags', 'Tags', 34], ['ultima_interacao', 'Última interação', 23],
  ['mensagens_nao_lidas', 'Mensagens não lidas', 23], ['id', 'ID do lead', 40],
] as const;

// Excel dates have no timezone: store Brasília wall time for display and sorting.
function excelDate(value: unknown): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : new Date(date.getTime() - 3 * 60 * 60 * 1000);
}

export function buildLeadsWorkbook(rows: ExportRow[], from?: string, to?: string): Workbook {
  const workbook = new Workbook();
  workbook.creator = 'CRM PRO';
  const sheet = workbook.addWorksheet('Entrada de leads', {
    views: [{ state: 'frozen', ySplit: 5, showGridLines: false }],
  });
  sheet.columns = columns.map(([key, , width]) => ({ key, width }));
  sheet.mergeCells('A1:M1');
  sheet.getCell('A1').value = 'CRM PRO | Relatório de entrada de leads';
  sheet.getCell('A1').font = { name: 'Calibri', size: 18, bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF152635' } };
  sheet.getRow(1).height = 38;
  const label = (value?: string) => value ? new Date(value).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '';
  sheet.mergeCells('A2:M2');
  sheet.getCell('A2').value = `Período de entrada: ${label(from) || 'Sem início definido'} até ${label(to) || 'Sem fim definido'} | Total exportado: ${rows.length} leads`;
  sheet.mergeCells('A3:M3');
  sheet.getCell('A3').value = 'Datas e horários de Brasília. Considera a criação do lead e os filtros e permissões de quem exportou.';
  sheet.getRow(2).height = 25;
  sheet.getRow(3).height = 25;
  sheet.getRow(5).values = columns.map(([, title]) => title);
  sheet.getRow(5).height = 30;
  sheet.getRow(5).eachCell((cell) => {
    cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF087F5B' } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  for (const source of rows) {
    const row = sheet.addRow(columns.map(([key]) => {
      const value = source[key];
      if (key === 'created_at' || key === 'ultima_interacao') return excelDate(value);
      if (key === 'valor_estimado' || key === 'mensagens_nao_lidas') return value == null ? null : Number(value);
      return value == null || value === '' ? null : String(value);
    }));
    const lines = columns.map(([key, , width]) => String(source[key] ?? '').split('\n')
      .reduce((count, line) => count + Math.max(1, Math.ceil(line.length / (width - 2))), 0));
    row.height = Math.min(409, Math.max(32, Math.max(...lines) * 16 + 8));
    row.eachCell({ includeEmpty: true }, (cell, index) => {
      cell.font = { name: 'Calibri', size: 11, color: { argb: 'FF243746' } };
      cell.alignment = { vertical: 'middle', horizontal: index === 9 || index === 12 ? 'right' : 'left', wrapText: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: row.number % 2 === 0 ? 'FFF0F5F7' : 'FFFFFFFF' } };
    });
    row.getCell(2).numFmt = '@';
    row.getCell(4).numFmt = 'dd/mm/yyyy hh:mm';
    row.getCell(11).numFmt = 'dd/mm/yyyy hh:mm';
    row.getCell(9).numFmt = '"R$" #,##0.00';
    row.getCell(12).numFmt = '0';
  }
  sheet.autoFilter = { from: 'A5', to: `M${Math.max(5, sheet.rowCount)}` };
  return workbook;
}
