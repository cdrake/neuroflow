function hdr = nf_nifti_header(imagePath, outDir)
%NF_NIFTI_HEADER Read a NIfTI-1 or NIfTI-2 header and write it as header.json.
%   hdr = NF_NIFTI_HEADER(imagePath, outDir) reads the header of a .nii or
%   .nii.gz file with no toolbox (MATLAB R2016b+ or GNU Octave 7+), computes the
%   qform and sform affines, their agreement and the voxel-axis orientation
%   code (e.g. 'LAS'), writes fullfile(outDir, 'header.json') and returns the
%   same struct. Data is never loaded; a gzipped file is decompressed to a
%   temporary directory that is removed afterwards.
%
%   This is the reference entry for the NeuroFlow MATLAB adapter
%   (gallery/scripts/matlab_tool.mjs); see docs/matlab-tools.md.

  if nargin < 2 || isempty(outDir), outDir = pwd; end
  if ~exist(imagePath, 'file'), error('nf_nifti_header:missing', 'no such file: %s', imagePath); end

  tmp = '';
  path = imagePath;
  if numel(path) > 3 && strcmpi(path(end-2:end), '.gz')
    tmp = tempname();
    mkdir(tmp);
    gunzip(path, tmp);
    listing = dir(fullfile(tmp, '*'));
    listing = listing(~[listing.isdir]);
    if isempty(listing), error('nf_nifti_header:gunzip', 'gunzip produced nothing for %s', imagePath); end
    path = fullfile(tmp, listing(1).name);
  end
  cleanup = onCleanup(@() nf_rmdir(tmp));

  fid = fopen(path, 'r', 'ieee-le');
  if fid < 0, error('nf_nifti_header:open', 'cannot open %s', path); end
  sizeofHdr = fread(fid, 1, 'int32');
  endian = 'little';
  if ~any(sizeofHdr == [348 540])
    fclose(fid);
    fid = fopen(path, 'r', 'ieee-be');
    sizeofHdr = fread(fid, 1, 'int32');
    endian = 'big';
  end
  if sizeofHdr == 348
    raw = nf_read_nifti1(fid);
    format = 'nifti-1';
  elseif sizeofHdr == 540
    raw = nf_read_nifti2(fid);
    format = 'nifti-2';
  else
    fclose(fid);
    error('nf_nifti_header:format', '%s is not a NIfTI file (sizeof_hdr = %d)', imagePath, sizeofHdr);
  end
  fclose(fid);

  ndim = max(0, min(7, raw.dim(1)));
  dims = raw.dim(2:1+ndim);
  pixdim = raw.pixdim(2:1+ndim);

  hdr = struct();
  hdr.file = imagePath;
  hdr.format = format;
  hdr.endian = endian;
  hdr.magic = raw.magic;
  hdr.ndim = ndim;
  hdr.dim = dims(:)';
  hdr.pixdim = pixdim(:)';
  vox = raw.pixdim(2:min(4, 1+ndim));
  hdr.voxelSize = vox(:)';
  hdr.datatype = nf_datatype_name(raw.datatype);
  hdr.datatypeCode = raw.datatype;
  hdr.bitpix = raw.bitpix;
  hdr.voxOffset = raw.vox_offset;
  hdr.sclSlope = raw.scl_slope;
  hdr.sclInter = raw.scl_inter;
  hdr.calMin = raw.cal_min;
  hdr.calMax = raw.cal_max;
  hdr.toffset = raw.toffset;
  units = nf_units(raw.xyzt_units);
  hdr.spatialUnits = units.space;
  hdr.temporalUnits = units.time;
  hdr.intentCode = raw.intent_code;
  hdr.intentName = raw.intent_name;
  hdr.descrip = raw.descrip;
  hdr.auxFile = raw.aux_file;
  hdr.qformCode = raw.qform_code;
  hdr.sformCode = raw.sform_code;
  hdr.qform = nf_qform(raw);
  hdr.sform = [raw.srow_x; raw.srow_y; raw.srow_z; 0 0 0 1];
  if raw.qform_code > 0 && raw.sform_code > 0
    hdr.qformSformAgree = max(abs(hdr.qform(:) - hdr.sform(:))) < 1e-3;
  else
    hdr.qformSformAgree = [];
  end
  if raw.sform_code > 0
    best = hdr.sform;
  elseif raw.qform_code > 0
    best = hdr.qform;
  else
    best = hdr.qform;
  end
  hdr.affine = best;
  hdr.orientation = nf_orientation(best);
  hdr.voxels = prod(max(dims(1:min(3, ndim)), 1));

  jsonText = jsonencode(hdr);
  outPath = fullfile(outDir, 'header.json');
  fid = fopen(outPath, 'w');
  if fid < 0, error('nf_nifti_header:write', 'cannot write %s', outPath); end
  fprintf(fid, '%s', jsonText);
  fclose(fid);
end

function raw = nf_read_nifti1(fid)
  frewind(fid);
  fseek(fid, 40, 'bof');
  raw.dim = fread(fid, 8, 'int16')';
  raw.intent_p = fread(fid, 3, 'float32')';
  raw.intent_code = fread(fid, 1, 'int16');
  raw.datatype = fread(fid, 1, 'int16');
  raw.bitpix = fread(fid, 1, 'int16');
  raw.slice_start = fread(fid, 1, 'int16');
  raw.pixdim = fread(fid, 8, 'float32')';
  raw.vox_offset = fread(fid, 1, 'float32');
  raw.scl_slope = fread(fid, 1, 'float32');
  raw.scl_inter = fread(fid, 1, 'float32');
  raw.slice_end = fread(fid, 1, 'int16');
  raw.slice_code = fread(fid, 1, 'uint8');
  raw.xyzt_units = fread(fid, 1, 'uint8');
  raw.cal_max = fread(fid, 1, 'float32');
  raw.cal_min = fread(fid, 1, 'float32');
  raw.slice_duration = fread(fid, 1, 'float32');
  raw.toffset = fread(fid, 1, 'float32');
  fseek(fid, 148, 'bof');
  raw.descrip = nf_cstr(fread(fid, 80, 'uint8=>char')');
  raw.aux_file = nf_cstr(fread(fid, 24, 'uint8=>char')');
  raw.qform_code = fread(fid, 1, 'int16');
  raw.sform_code = fread(fid, 1, 'int16');
  q = fread(fid, 6, 'float32')';
  raw.quatern = q(1:3);
  raw.qoffset = q(4:6);
  raw.srow_x = fread(fid, 4, 'float32')';
  raw.srow_y = fread(fid, 4, 'float32')';
  raw.srow_z = fread(fid, 4, 'float32')';
  raw.intent_name = nf_cstr(fread(fid, 16, 'uint8=>char')');
  raw.magic = nf_cstr(fread(fid, 4, 'uint8=>char')');
end

function raw = nf_read_nifti2(fid)
  fseek(fid, 4, 'bof');
  raw.magic = nf_cstr(fread(fid, 8, 'uint8=>char')');
  raw.datatype = fread(fid, 1, 'int16');
  raw.bitpix = fread(fid, 1, 'int16');
  raw.dim = double(fread(fid, 8, 'int64'))';
  raw.intent_p = fread(fid, 3, 'float64')';
  raw.pixdim = fread(fid, 8, 'float64')';
  raw.vox_offset = double(fread(fid, 1, 'int64'));
  raw.scl_slope = fread(fid, 1, 'float64');
  raw.scl_inter = fread(fid, 1, 'float64');
  raw.cal_max = fread(fid, 1, 'float64');
  raw.cal_min = fread(fid, 1, 'float64');
  raw.slice_duration = fread(fid, 1, 'float64');
  raw.toffset = fread(fid, 1, 'float64');
  raw.slice_start = double(fread(fid, 1, 'int64'));
  raw.slice_end = double(fread(fid, 1, 'int64'));
  raw.descrip = nf_cstr(fread(fid, 80, 'uint8=>char')');
  raw.aux_file = nf_cstr(fread(fid, 24, 'uint8=>char')');
  raw.qform_code = fread(fid, 1, 'int32');
  raw.sform_code = fread(fid, 1, 'int32');
  q = fread(fid, 6, 'float64')';
  raw.quatern = q(1:3);
  raw.qoffset = q(4:6);
  raw.srow_x = fread(fid, 4, 'float64')';
  raw.srow_y = fread(fid, 4, 'float64')';
  raw.srow_z = fread(fid, 4, 'float64')';
  raw.slice_code = fread(fid, 1, 'int32');
  raw.xyzt_units = fread(fid, 1, 'int32');
  raw.intent_code = fread(fid, 1, 'int32');
  raw.intent_name = nf_cstr(fread(fid, 16, 'uint8=>char')');
end

function s = nf_cstr(chars)
  z = find(chars == 0, 1);
  if ~isempty(z), chars = chars(1:z-1); end
  s = strtrim(char(chars));
end

function M = nf_qform(raw)
  % NIfTI-1 "method 2": rotation from the quaternion, scaled by pixdim, qfac from pixdim(1).
  if raw.qform_code <= 0
    M = diag([raw.pixdim(2:4) 1]);
    return;
  end
  b = raw.quatern(1); c = raw.quatern(2); d = raw.quatern(3);
  a = 1 - (b*b + c*c + d*d);
  if a < 1e-7
    a = 1 / sqrt(b*b + c*c + d*d);
    b = b*a; c = c*a; d = d*a;
    a = 0;
  else
    a = sqrt(a);
  end
  R = [a*a+b*b-c*c-d*d, 2*b*c-2*a*d,     2*b*d+2*a*c;
       2*b*c+2*a*d,     a*a+c*c-b*b-d*d, 2*c*d-2*a*b;
       2*b*d-2*a*c,     2*c*d+2*a*b,     a*a+d*d-c*c-b*b];
  qfac = 1; if raw.pixdim(1) < 0, qfac = -1; end
  M = [R * diag([raw.pixdim(2), raw.pixdim(3), raw.pixdim(4) * qfac]), raw.qoffset(:); 0 0 0 1];
end

function code = nf_orientation(M)
  % Where each voxel axis points in world (RAS) space, e.g. 'LAS' for radiological NIfTI.
  pos = 'RAS'; neg = 'LPI';
  R = M(1:3, 1:3);
  code = '';
  for j = 1:3
    [~, i] = max(abs(R(:, j)));
    if R(i, j) >= 0, code(end+1) = pos(i); else, code(end+1) = neg(i); end
  end
end

function name = nf_datatype_name(code)
  switch code
    case 1, name = 'binary';
    case 2, name = 'uint8';
    case 4, name = 'int16';
    case 8, name = 'int32';
    case 16, name = 'float32';
    case 32, name = 'complex64';
    case 64, name = 'float64';
    case 128, name = 'rgb24';
    case 256, name = 'int8';
    case 512, name = 'uint16';
    case 768, name = 'uint32';
    case 1024, name = 'int64';
    case 1280, name = 'uint64';
    case 1536, name = 'float128';
    case 1792, name = 'complex128';
    case 2048, name = 'complex256';
    case 2304, name = 'rgba32';
    otherwise, name = sprintf('unknown(%d)', code);
  end
end

function u = nf_units(code)
  code = double(code);
  s = mod(code, 8);
  t = code - s;
  space = {'unknown', 'm', 'mm', 'um'};
  u.space = 'unknown';
  if s >= 1 && s <= 3, u.space = space{s+1}; end
  switch t
    case 8, u.time = 's';
    case 16, u.time = 'ms';
    case 24, u.time = 'us';
    case 32, u.time = 'hz';
    case 40, u.time = 'ppm';
    case 48, u.time = 'rad/s';
    otherwise, u.time = 'unknown';
  end
end

function nf_rmdir(tmp)
  if ~isempty(tmp) && exist(tmp, 'dir')
    rmdir(tmp, 's');
  end
end
