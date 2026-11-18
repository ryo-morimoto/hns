/**
 * A PDF a test opens, as bytes.
 *
 * @remarks
 * Written once by `pdf-lib` (Helvetica, one line of text per page) and kept here as base64: the
 * viewer tests need the **real reader** — PDF.js, its parsing, its text extraction — and a
 * fixture built at test time would need a PDF writer in the product's dependency graph, which it
 * does not have. Each page says "Page N", so a test can see which page it is looking at.
 */
const ONE_PAGE =
  "JVBERi0xLjcKJYGBgYEKCjYgMCBvYmoKPDwKL0ZpbHRlciAvRmxhdGVEZWNvZGUKL0xlbmd0aCA5Mwo+PgpzdHJlYW0KeJwr5HIK4TJQAMGidC59j9ScstSSzOREXXMDSwsTCwNzC0sFQwuFkDQuIxOFEB8uQ7BSQwUjIGFqoBCSy2VjamBmaGZuZmpkYGxopxCSxRWixeUawhXIBQDfDhQwCmVuZHN0cmVhbQplbmRvYmoKCjcgMCBvYmoKPDwKL0ZpbHRlciAvRmxhdGVEZWNvZGUKL1R5cGUgL09ialN0bQovTiA1Ci9GaXJzdCAyNgovTGVuZ3RoIDM2Mgo+PgpzdHJlYW0KeJzVU01PwzAMvedX+AgHlI9m/UDTpG1tQUITaEMCgTh0bTQVTQlqUzT+PXbbDe2AOHN4Smw/O3byIkGAAq0hgCgGDZNAwQRCqWE6Zfzx68MAfyh2pmX8rq5aeMWogDW8Mb50nfUg2WzGfrjLwhd7t2NDEkgiHxkPjau60jQwzbM8FyISQoQaEQqhUlyXiASh0MaYinGPiPQI9EWBEMEcY/mAMBpyKN5zJ2N+hityQ+KkA1fHg306l87Khhrqr36SGeMrV6WFN3CRXiuhQillrJROhH65xOtoTOHd/x2u77929tcJz945d9Yzvum2vjfJKRlfFK2hCPBbs/80vi4LxjNbuqq2O+BPtZ3btj46ziuSYEg2jSFV9brha9O6rilRSMTrK9PmVPwqEkmMk0dxgtodpcaf77fvpuypZGYHf7PxNNXgIN/KVHWxcAfUs6AfIAagqufWOk867xVuPXZDVjiqHpO/AZFwxd8KZW5kc3RyZWFtCmVuZG9iagoKOCAwIG9iago8PAovU2l6ZSA5Ci9Sb290IDIgMCBSCi9JbmZvIDMgMCBSCi9GaWx0ZXIgL0ZsYXRlRGVjb2RlCi9UeXBlIC9YUmVmCi9MZW5ndGggNDAKL1cgWyAxIDIgMiBdCi9JbmRleCBbIDAgOSBdCj4+CnN0cmVhbQp4nBXEsREAIAwDsbfDHS1LMxLzJViFgG6zISk5VVrigHg/Xxhg2QOFCmVuZHN0cmVhbQplbmRvYmoKCnN0YXJ0eHJlZgo2NDUKJSVFT0Y=";

const THREE_PAGES =
  "JVBERi0xLjcKJYGBgYEKCjYgMCBvYmoKPDwKL0ZpbHRlciAvRmxhdGVEZWNvZGUKL0xlbmd0aCA5Mwo+PgpzdHJlYW0KeJwr5HIK4TJQAMGidC59j9ScstSSzOREXXMDSwsTCwNzC0sFQwuFkDQuIxOFEB8uQ7BSQwUjIGFqoBCSy2VjamBmaGZuZmpkYGxopxCSxRWixeUawhXIBQDfDhQwCmVuZHN0cmVhbQplbmRvYmoKCjggMCBvYmoKPDwKL0ZpbHRlciAvRmxhdGVEZWNvZGUKL0xlbmd0aCA5Mwo+PgpzdHJlYW0KeJwr5HIK4TJQAMGidC59j9ScstSSzOREXUtzEyMzCyNTMwsFQwuFkDQuIxOFEB8uQ7BSQwUjIGFqoBCSy2VjamBmaGZuZmpkYGxkpxCSxRWixeUawhXIBQDeexQuCmVuZHN0cmVhbQplbmRvYmoKCjEwIDAgb2JqCjw8Ci9GaWx0ZXIgL0ZsYXRlRGVjb2RlCi9MZW5ndGggOTMKPj4Kc3RyZWFtCnicK+RyCuEyUADBonQufY/UnLLUkszkRF0jAwMDCwNTSwszBUMLhZA0LiMThRAfLkOwUkMFIyBhaqAQkstlY2pgZmhmbmZqZGBsbKcQksUVosXlGsIVyAUA2ZkUHAplbmRzdHJlYW0KZW5kb2JqCgoxMSAwIG9iago8PAovRmlsdGVyIC9GbGF0ZURlY29kZQovVHlwZSAvT2JqU3RtCi9OIDcKL0ZpcnN0IDM4Ci9MZW5ndGggNDA0Cj4+CnN0cmVhbQp4nNVUwU7cMBC9+yvm2B6QJ17HsavVSstuQqUKFQFSEaiHkFirIGRXibeif9+ZeAFxqDhQDhye7Zl5Hj8nLykAQUFpYAEOQUOpCWCUgQosluDAWQ3LpZCXf355kGftzk9Cfhv6CW6IiXBOTB7dPP4UchP3IcFCrFbied+mTe193IncAAomPzLOxtjvOz/CsqmbBrFCRKMJBlFtad4QHEFRTDVlaU2o9AGUqxaIizXVmgxT5T1cn7nlYX9NM3ENc7aZq22On87ls+rcQ72mx62EPI39tk0ePm2/KFSmKAqrlHaorz/T4xh9m+LHvdysf4jhnzd88Z6bGJKQF/vbNIecLIQ8bifPFZBf/f1vn4auFbIOXeyHsAP5YwjrMA2PiZcd2TBsm9HT/uwbee6nuB87MhLz5s68eGp+VCHZ1mJlHXn6YDV59f32znczlcP6IZ1cJL5VTnDu1PdDexwfyNvIXwZmkKvXIcTEnp8dHhKp4cgcXP92ya7SylhVGvvOku1/k8x+pZ+Es+adJRf4rPkvIwEqLwplbmRzdHJlYW0KZW5kb2JqCgoxMiAwIG9iago8PAovU2l6ZSAxMwovUm9vdCAyIDAgUgovSW5mbyAzIDAgUgovRmlsdGVyIC9GbGF0ZURlY29kZQovVHlwZSAvWFJlZgovTGVuZ3RoIDUxCi9XIFsgMSAyIDIgXQovSW5kZXggWyAwIDEzIF0KPj4Kc3RyZWFtCnicJcqxDQAgDAPBNwEaGuZjT6ajCFg0p5dsILMwwMgUE6aK+Ycm9q8uLXx8xIELpkAElAplbmRzdHJlYW0KZW5kb2JqCgpzdGFydHhyZWYKMTAxOQolJUVPRg==";

/** Bytes from base64, in a fresh buffer per call (PDF.js takes ownership of what it is given). */
function bytesOf(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** A one-page PDF whose text is "Page 1". */
export function onePdf(): Uint8Array {
  return bytesOf(ONE_PAGE);
}

/** A three-page PDF whose pages say "Page 1", "Page 2", and "Page 3". */
export function threePdf(): Uint8Array {
  return bytesOf(THREE_PAGES);
}

/** A `Response` for one fixture, as the session route would answer it. */
export function pdfResponse(bytes: Uint8Array, status = 200): Response {
  return new Response(bytes.slice(), {
    status,
    headers: { "content-type": "application/pdf", "content-length": String(bytes.length) },
  });
}
