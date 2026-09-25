import { Workbook } from 'exceljs';
import { buildLeadsWorkbook, serializeLeadsWorkbook } from './leads-workbook';
import JSZip from 'jszip';

describe('Excel de entrada de leads', () => {
  it('preserva telefone, valores e datas de Brasília após salvar e reabrir', async () => {
    const workbook = buildLeadsWorkbook([{
      nome: '=SUM(1,2)', telefone: '0037999999999', valor_estimado: '1234.56',
      created_at: new Date('2026-09-02T01:30:00Z'), ultima_interacao: null,
    }], '2026-09-01T00:00:00-03:00', '2026-09-25T23:59:59-03:00');
    const reopened = new Workbook();
    const buffer = await serializeLeadsWorkbook(workbook);
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    expect(xml).toContain('t="inlineStr"><is><t>0037999999999</t></is>');
    expect(xml).not.toContain('t="s"');
    await reopened.xlsx.load(buffer as unknown as Parameters<typeof reopened.xlsx.load>[0]);
    const sheet = reopened.getWorksheet('Entrada de leads')!;
    expect(sheet.getCell('A6').value).toBe('=SUM(1,2)');
    expect(sheet.getCell('B6').value).toBe('0037999999999');
    expect(sheet.getCell('I6').value).toBe(1234.56);
    expect(sheet.getCell('D6').value).toEqual(new Date('2026-09-01T22:30:00Z'));
    expect(sheet.getCell('K6').value).toBeNull();
    expect(sheet.getCell('C6').value).toBeNull();
    expect(sheet.getCell('A2').value).toContain('Total exportado: 1 leads');
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 5 });
    expect(sheet.autoFilter).toBe('A5:M6');
  });
  it('gera cabeçalho e total zero mesmo sem resultados', () => {
    const sheet = buildLeadsWorkbook([]).worksheets[0];
    expect(sheet.getCell('A2').value).toContain('Total exportado: 0 leads');
    expect(sheet.getCell('A5').value).toBe('Nome');
  });
});
