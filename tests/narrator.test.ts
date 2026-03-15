import { describe, test, expect } from 'vitest';
import { expandAbbreviations, parseDuration } from '../src/narrator.js';

describe('expandAbbreviations', () => {
  test('expands Recon. → Reconciliation', () => {
    expect(expandAbbreviations('Bank Recon. List')).toBe('Bank Reconciliation List');
  });

  test('expands No. → Number', () => {
    expect(expandAbbreviations('Document No.')).toBe('Document Number');
  });

  test('expands Acc. → Account', () => {
    expect(expandAbbreviations('Bank Acc. Card')).toBe('Bank Account Card');
  });

  test('text with no abbreviations is unchanged', () => {
    const text = 'This is a normal sentence with no abbreviations';
    expect(expandAbbreviations(text)).toBe(text);
  });

  test('expands multiple abbreviations in one string', () => {
    expect(expandAbbreviations('Acc. No. for Pmt.')).toBe('Account Number for Payment');
  });

  test('expands all BC abbreviations', () => {
    expect(expandAbbreviations('Stmt.')).toBe('Statement');
    expect(expandAbbreviations('Amt.')).toBe('Amount');
    expect(expandAbbreviations('Bal.')).toBe('Balance');
    expect(expandAbbreviations('Qty.')).toBe('Quantity');
    expect(expandAbbreviations('Desc.')).toBe('Description');
    expect(expandAbbreviations('Doc.')).toBe('Document');
    expect(expandAbbreviations('Jnl.')).toBe('Journal');
    expect(expandAbbreviations('Gen.')).toBe('General');
    expect(expandAbbreviations('Cust.')).toBe('Customer');
    expect(expandAbbreviations('Vend.')).toBe('Vendor');
    expect(expandAbbreviations('Inv.')).toBe('Invoice');
    expect(expandAbbreviations('Dim.')).toBe('Dimension');
    expect(expandAbbreviations('Curr.')).toBe('Currency');
    expect(expandAbbreviations('Ext.')).toBe('External');
  });

  test('expands Id → I.D.', () => {
    expect(expandAbbreviations('Bank Id')).toBe('Bank I.D.');
  });
});

describe('parseDuration', () => {
  test('parses valid FFmpeg duration output', () => {
    const output = '  Duration: 00:00:04.32, start: 0.000000, bitrate: 128 kb/s';
    expect(parseDuration(output)).toBe(4320);
  });

  test('parses zero duration', () => {
    const output = '  Duration: 00:00:00.00, start: 0.000000';
    expect(parseDuration(output)).toBe(0);
  });

  test('parses multi-minute duration', () => {
    const output = '  Duration: 00:02:30.50, start: 0.000000';
    // 2*60000 + 30*1000 + 500 = 150500
    expect(parseDuration(output)).toBe(150500);
  });

  test('parses hour-long duration', () => {
    const output = '  Duration: 01:00:00.00, start: 0.000000';
    expect(parseDuration(output)).toBe(3600000);
  });

  test('throws on malformed output', () => {
    expect(() => parseDuration('no duration here')).toThrow(/Could not parse audio duration/);
  });

  test('throws on empty string', () => {
    expect(() => parseDuration('')).toThrow(/Could not parse audio duration/);
  });
});
