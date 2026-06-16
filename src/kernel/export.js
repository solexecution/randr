// Exporters. STL binary is the workhorse for FDM; 3MF carries units and is the
// better choice for modern slicers; OBJ is the lingua franca for round-tripping
// into other tools. All take a Manifold and return a Blob ready to download.

function meshArrays(manifold) {
  const mesh = manifold.getMesh();
  const { numProp, vertProperties, triVerts } = mesh;
  const verts = [];
  const vertCount = vertProperties.length / numProp;
  for (let i = 0; i < vertCount; i++) {
    verts.push([
      vertProperties[i * numProp],
      vertProperties[i * numProp + 1],
      vertProperties[i * numProp + 2],
    ]);
  }
  const tris = [];
  for (let i = 0; i < triVerts.length; i += 3) {
    tris.push([triVerts[i], triVerts[i + 1], triVerts[i + 2]]);
  }
  return { verts, tris };
}

function faceNormal(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

// Binary STL: 80-byte header, uint32 triangle count, then 50 bytes per triangle.
export function exportSTL(manifold) {
  const { verts, tris } = meshArrays(manifold);
  const buffer = new ArrayBuffer(84 + tris.length * 50);
  const view = new DataView(buffer);
  view.setUint32(80, tris.length, true);

  let offset = 84;
  for (const [ia, ib, ic] of tris) {
    const a = verts[ia], b = verts[ib], c = verts[ic];
    const n = faceNormal(a, b, c);
    view.setFloat32(offset, n[0], true);
    view.setFloat32(offset + 4, n[1], true);
    view.setFloat32(offset + 8, n[2], true);
    let o = offset + 12;
    for (const v of [a, b, c]) {
      view.setFloat32(o, v[0], true);
      view.setFloat32(o + 4, v[1], true);
      view.setFloat32(o + 8, v[2], true);
      o += 12;
    }
    view.setUint16(offset + 48, 0, true); // attribute byte count
    offset += 50;
  }
  return new Blob([buffer], { type: 'model/stl' });
}

export function exportOBJ(manifold) {
  const { verts, tris } = meshArrays(manifold);
  const lines = ['# Forge CAD export', 'o part'];
  for (const v of verts) lines.push(`v ${v[0]} ${v[1]} ${v[2]}`);
  for (const t of tris) lines.push(`f ${t[0] + 1} ${t[1] + 1} ${t[2] + 1}`);
  return new Blob([lines.join('\n')], { type: 'model/obj' });
}

// 3MF is a zip, but a minimal single-mesh 3MF can be written as the core
// model XML inside a tiny zip. To stay dependency-free we emit the model XML
// uncompressed in a STORED zip we assemble by hand.
export function export3MF(manifold) {
  const { verts, tris } = meshArrays(manifold);
  const vertXml = verts
    .map((v) => `<vertex x="${v[0]}" y="${v[1]}" z="${v[2]}"/>`)
    .join('');
  const triXml = tris
    .map((t) => `<triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"/>`)
    .join('');
  const model =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<model unit="millimeter" xml:lang="en-US" ` +
    `xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<resources><object id="1" type="model"><mesh>` +
    `<vertices>${vertXml}</vertices><triangles>${triXml}</triangles>` +
    `</mesh></object></resources>` +
    `<build><item objectid="1"/></build></model>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>` +
    `</Types>`;

  const rels =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Target="/3D/3dmodel.model" Id="rel0" ` +
    `Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;

  return zipStore([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: '3D/3dmodel.model', data: model },
  ]);
}

// Minimal STORED (no compression) zip writer. Enough for slicers to read 3MF.
function zipStore(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  const crcTable = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = enc.encode(f.data);
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0, true);
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, 0, true);
    local.setUint16(12, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);

    chunks.push(new Uint8Array(local.buffer), nameBytes, data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(10, 0, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    central.push({ header: new Uint8Array(cd.buffer), name: nameBytes });

    offset += 30 + nameBytes.length + data.length;
  }

  let cdSize = 0;
  const cdStart = offset;
  for (const c of central) {
    chunks.push(c.header, c.name);
    cdSize += c.header.length + c.name.length;
  }

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, cdStart, true);
  chunks.push(new Uint8Array(end.buffer));

  return new Blob(chunks, { type: 'model/3mf' });
}

export function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
