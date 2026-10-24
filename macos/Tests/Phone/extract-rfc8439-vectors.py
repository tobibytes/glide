import re, json, sys
L = open(sys.argv[1]).read().split('\n')
dump = re.compile(r'^\s*\d{3}  ((?:[0-9a-fA-F]{2} ){0,15}[0-9a-fA-F]{2})(?:\s|$)')
colon = re.compile(r'^\s*((?:[0-9a-fA-F]{2}:)+[0-9a-fA-F]{2}:?)\s*$')
spaced = re.compile(r'^\s*((?:[0-9a-fA-F]{2} )*[0-9a-fA-F]{2})\s*$')
def block(n):
    """hex bytes following the label on line n (1-based) until the next label/prose."""
    out = []
    i = n  # next line index (0-based = n)
    started = False
    while i < len(L):
        s = L[i]
        if s.startswith('Nir & Langley') or s.startswith('RFC 8439') or s.strip()=='' :
            i += 1
            if started and s.strip()=='' :
                # allow page breaks: peek ahead for continuation dump line
                j=i
                while j<len(L) and (L[j].strip()=='' or L[j].startswith('Nir &') or L[j].startswith('RFC 8439')): j+=1
                if j<len(L) and dump.match(L[j]) and not L[j].strip().startswith('000'):
                    i=j; continue
                break
            continue
        m = dump.match(s) or colon.match(s) or spaced.match(s)
        if not m: break
        started = True
        out += re.findall(r'[0-9a-fA-F]{2}', m.group(1))
        i += 1
    return ''.join(out).lower()
def inline(n):  # "Tag: a8:06:..." on the same line
    return ''.join(re.findall(r'[0-9a-f]{2}', L[n-1].split(':',1)[1])).lower()
v = {
 "block": {"key": "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "nonce": "000000090000004a00000000", "counter": 1, "out": block(576)},
 "chacha20": [
   {"key": "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "nonce": "000000000000004a00000000", "counter": 1, "pt": block(679), "ct": block(745)},
 ],
 "poly1305": [{"key": "85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b", "msg": block(735-735+ (L.index('  Message to be Authenticated:')+1)), "tag": inline(973)}],
 "keygen": [{"key": block(1038), "nonce": block(1042), "otk": block(1057)}],
 "aead": [
   {"key": block(1276), "nonce": "07000000" + block(1280), "aad": block(1273), "pt": block(1263), "ct": block(1324), "tag": block(1366)},
   {"key": block(2359), "nonce": block(2382), "aad": block(2385), "pt": block(2478), "ct": block(2363), "tag": block(2388)},
 ],
}
for t in (1638, 1662, 1693, 1717, 1749):
    pass
# A.2 ChaCha20 encryption vectors
for (k, n, c, p, ct) in ((1804, 1808, 0, 1813, 1819), (1828, 1832, 1, 1855, 1911), (1940, 1944, 42, 1949, 1967)):
    v["chacha20"].append({"key": block(k), "nonce": block(n), "counter": c, "pt": block(p), "ct": block(ct)})
# A.3 Poly1305
for (k, m, t) in ((1989, 1993, 1999), (2005, 2023, 2049), (2055, 2079, 2105), (2138, 2142, 2152)):
    v["poly1305"].append({"key": block(k), "msg": block(m), "tag": block(t)})
for (r, s, d, t) in ((2159,2161,2163,2165),(2170,2172,2174,2176),(2194,2196,2198,2202),(2208,2210,2212,2216),(2222,2224,2226,2228),(2250,2252,2254,2259),(2265,2267,2269,2273)):
    v["poly1305"].append({"key": block(r)+block(s), "msg": block(d), "tag": block(t)})
# A.4 key generation
for (k, n) in ((2281, 2285), (2306, 2310), (2320, 2324)):
    v["keygen"].append({"key": block(k), "nonce": block(n), "otk": block(n + 3)})
json.dump(v, sys.stdout, indent=1)
