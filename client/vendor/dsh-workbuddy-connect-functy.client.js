window.__ModuleLoader__.load({
	id: "dsh-workbuddy-connect-functy",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_dom = require("react-dom");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/status-paths.ts
		/**
		* How long a benched account stays benched, in the unit that reads best.
		*
		* Shared rather than written on each side because both halves describe the same
		* field of the same document, and the CLI and the settings page disagreeing
		* about how long a cooldown has left would read as one of them being wrong. The
		* *wording* stays local, because only each side knows its language.
		*
		* The hour unit exists because an upstream-stated reset can be most of a day
		* away, and "1078 分钟" is a number nobody converts in their head.
		*/
		function describeWait(untilMs, now) {
			const minutes = Math.max(1, Math.ceil(Math.max(0, untilMs - now) / 6e4));
			return minutes < 60 ? {
				unit: "minute",
				value: minutes
			} : {
				unit: "hour",
				value: Math.ceil(minutes / 60)
			};
		}
		/** Plugin-owned status endpoint consumed by its browser half. */
		const WORKBUDDY_STATUS_PATH = "/plugins/dsh-workbuddy-connect-functy/status";
		/**
		* Plugin-owned probe control endpoint.
		*
		* Separate from the status route because it accepts writes: the status route's
		* loopback Host/Origin guard protects against a DNS-rebinding *page*, which is
		* not the same as authorizing a state-changing action. This route therefore
		* also requires the in-process key the browser half receives with the status
		* document.
		*/
		const WORKBUDDY_PROBE_PATH = "/plugins/dsh-workbuddy-connect-functy/probe";
		/**
		* The international (WorkBuddy AI) variant's own pair of routes.
		*
		* Kept as separate constants rather than a computed suffix so both halves
		* reference literal strings: the browser bundle and the host bundle are built
		* independently, and a shared expression is one build-config drift away from
		* the desk asking a route the host never mounted.
		*/
		const WORKBUDDY_AI_STATUS_PATH = "/plugins/dsh-workbuddy-connect-functy/ai/status";
		const WORKBUDDY_AI_PROBE_PATH = "/plugins/dsh-workbuddy-connect-functy/ai/probe";
		/**
		* Account-management routes, one pair per variant.
		*
		* Separate from the probe route because they act on different state (the
		* account pool, not probe records) and because a browser that fails to reach
		* one must not lose the other. Both are writes and therefore carry the same
		* in-process key as the probe route.
		*/
		const WORKBUDDY_ACCOUNT_PATH = "/plugins/dsh-workbuddy-connect-functy/accounts";
		const WORKBUDDY_AI_ACCOUNT_PATH = "/plugins/dsh-workbuddy-connect-functy/ai/accounts";
		/** Whether a value is one of the closed set of sidebar credit styles. */
		function isWorkBuddySidebarCreditStyle(value) {
			return value === "remaining" || value === "usage";
		}
		/** Both products, in display order. */
		const CARD_VARIANTS = [{
			id: "workbuddy",
			titleKey: "title",
			introKey: "intro",
			signedOutKey: "signedOutHint",
			statusPath: WORKBUDDY_STATUS_PATH,
			probePath: WORKBUDDY_PROBE_PATH,
			accountPath: WORKBUDDY_ACCOUNT_PATH,
			appName: "WorkBuddy"
		}, {
			id: "workbuddy-ai",
			titleKey: "titleAI",
			introKey: "introAI",
			signedOutKey: "signedOutHintAI",
			statusPath: WORKBUDDY_AI_STATUS_PATH,
			probePath: WORKBUDDY_AI_PROBE_PATH,
			accountPath: WORKBUDDY_AI_ACCOUNT_PATH,
			appName: "WorkBuddy AI"
		}];
		//#endregion
		//#region src/client/qr-code.ts
		/** Mode indicator for 8-bit byte mode. */
		const MODE_BYTE = 4;
		/**
		* Data capacity, in bytes, for levels M by version (1-20), byte mode.
		*
		* From the Model 2 capacity tables: total codewords minus the error-correction
		* codewords for that version, minus the mode/length header, rounded down. Held
		* as a table because the block structures below are also tabulated and driving
		* one from the other invites an off-by-one that only shows up at one version.
		*/
		const BYTE_CAPACITY_M = [
			14,
			26,
			42,
			62,
			84,
			106,
			122,
			152,
			180,
			213,
			251,
			287,
			331,
			362,
			412,
			450,
			504,
			560,
			624,
			666
		];
		const BLOCKS_M = [
			{
				ecPerBlock: 10,
				groups: [[1, 16]]
			},
			{
				ecPerBlock: 16,
				groups: [[1, 28]]
			},
			{
				ecPerBlock: 26,
				groups: [[1, 44]]
			},
			{
				ecPerBlock: 18,
				groups: [[2, 32]]
			},
			{
				ecPerBlock: 24,
				groups: [[2, 43]]
			},
			{
				ecPerBlock: 16,
				groups: [[4, 27]]
			},
			{
				ecPerBlock: 18,
				groups: [[4, 31]]
			},
			{
				ecPerBlock: 22,
				groups: [[2, 38], [2, 39]]
			},
			{
				ecPerBlock: 22,
				groups: [[3, 36], [2, 37]]
			},
			{
				ecPerBlock: 26,
				groups: [[4, 43], [1, 44]]
			},
			{
				ecPerBlock: 30,
				groups: [[1, 50], [4, 51]]
			},
			{
				ecPerBlock: 22,
				groups: [[6, 36], [2, 37]]
			},
			{
				ecPerBlock: 22,
				groups: [[8, 37], [1, 38]]
			},
			{
				ecPerBlock: 24,
				groups: [[4, 40], [5, 41]]
			},
			{
				ecPerBlock: 24,
				groups: [[5, 41], [5, 42]]
			},
			{
				ecPerBlock: 28,
				groups: [[7, 45], [3, 46]]
			},
			{
				ecPerBlock: 28,
				groups: [[10, 46], [1, 47]]
			},
			{
				ecPerBlock: 26,
				groups: [[9, 43], [4, 44]]
			},
			{
				ecPerBlock: 26,
				groups: [[3, 44], [11, 45]]
			},
			{
				ecPerBlock: 26,
				groups: [[3, 41], [13, 42]]
			}
		];
		/**
		* Alignment pattern centre coordinates per version.
		*
		* The spec's own table; the arithmetic rule that generates it has exceptions at
		* the low versions and the table is shorter to read than the rule.
		*/
		const ALIGNMENT_CENTRES = [
			[],
			[6, 18],
			[6, 22],
			[6, 26],
			[6, 30],
			[6, 34],
			[
				6,
				22,
				38
			],
			[
				6,
				24,
				42
			],
			[
				6,
				26,
				46
			],
			[
				6,
				28,
				50
			],
			[
				6,
				30,
				54
			],
			[
				6,
				32,
				58
			],
			[
				6,
				34,
				62
			],
			[
				6,
				26,
				46,
				66
			],
			[
				6,
				26,
				48,
				70
			],
			[
				6,
				26,
				50,
				74
			],
			[
				6,
				30,
				54,
				78
			],
			[
				6,
				30,
				56,
				82
			],
			[
				6,
				30,
				58,
				86
			],
			[
				6,
				34,
				62,
				90
			]
		];
		function encodeQrCode(text, options = {}) {
			const bytes = new TextEncoder().encode(text);
			const version = smallestVersion(bytes.length);
			if (version === void 0) throw new Error(`QR payload of ${String(bytes.length)} bytes exceeds the supported capacity`);
			const size = version * 4 + 17;
			return {
				size,
				modules: placeCodewords(buildCodewords(bytes, version), version, size, options.mask)
			};
		}
		/** The lowest version whose level-M byte capacity fits, or undefined. */
		function smallestVersion(byteLength) {
			for (let index = 0; index < BYTE_CAPACITY_M.length; index += 1) if (byteLength <= BYTE_CAPACITY_M[index]) return index + 1;
		}
		/**
		* The final codeword sequence: mode + length + data + terminator + padding,
		* split into blocks, each block extended with its own Reed–Solomon codewords,
		* then interleaved in the spec's order.
		*/
		function buildCodewords(bytes, version) {
			const layout = BLOCKS_M[version - 1];
			const totalData = layout.groups.reduce((sum, [count, per]) => sum + count * per, 0);
			const bits = [];
			pushBits(bits, MODE_BYTE, 4);
			pushBits(bits, bytes.length, version < 10 ? 8 : 16);
			for (const byte of bytes) pushBits(bits, byte, 8);
			const capacityBits = totalData * 8;
			pushBits(bits, 0, Math.min(4, capacityBits - bits.length));
			pushBits(bits, 0, (8 - bits.length % 8) % 8);
			const data = [];
			for (let index = 0; index < bits.length; index += 8) {
				let value = 0;
				for (let offset = 0; offset < 8; offset += 1) value = value << 1 | (bits[index + offset] ?? 0);
				data.push(value);
			}
			const PAD = [236, 17];
			for (let index = 0; data.length < totalData; index += 1) data.push(PAD[index % 2]);
			const blocks = [];
			let cursor = 0;
			for (const [count, per] of layout.groups) for (let block = 0; block < count; block += 1) {
				blocks.push(data.slice(cursor, cursor + per));
				cursor += per;
			}
			const ecBlocks = blocks.map((block) => reedSolomon(block, layout.ecPerBlock));
			const out = [];
			const maxData = Math.max(...blocks.map((block) => block.length));
			for (let index = 0; index < maxData; index += 1) for (const block of blocks) {
				const value = block[index];
				if (value !== void 0) out.push(value);
			}
			for (let index = 0; index < layout.ecPerBlock; index += 1) for (const block of ecBlocks) {
				const value = block[index];
				if (value !== void 0) out.push(value);
			}
			return out;
		}
		/** Append the low `count` bits of `value`, most significant first. */
		function pushBits(bits, value, count) {
			for (let shift = count - 1; shift >= 0; shift -= 1) bits.push(value >> shift & 1);
		}
		/**
		* Reed–Solomon codewords over GF(256) with the QR primitive polynomial 0x11d.
		*
		* The remainder of the message times `x^ecLength` divided by the generator
		* polynomial, computed with the shift register the spec describes.
		*/
		function reedSolomon(data, ecLength) {
			const generator = generatorPolynomial(ecLength).slice(1);
			const remainder = new Array(ecLength).fill(0);
			for (const byte of data) {
				const factor = byte ^ remainder[0];
				remainder.shift();
				remainder.push(0);
				for (let index = 0; index < ecLength; index += 1) remainder[index] = remainder[index] ^ gfMultiply(factor, generator[index]);
			}
			return remainder;
		}
		/**
		* The degree-`ecLength` generator polynomial, as coefficients with the leading
		* 1 dropped: `(x - a^0)(x - a^1)...(x - a^(ecLength-1))`.
		*/
		function generatorPolynomial(ecLength) {
			let polynomial = [1];
			for (let index = 0; index < ecLength; index += 1) {
				const next = new Array(polynomial.length + 1).fill(0);
				for (let term = 0; term < polynomial.length; term += 1) {
					next[term] = next[term] ^ polynomial[term];
					next[term + 1] = next[term + 1] ^ gfMultiply(polynomial[term], gfPower(index));
				}
				polynomial = next;
			}
			return polynomial;
		}
		/** Multiply two GF(256) elements modulo the QR primitive polynomial. */
		function gfMultiply(left, right) {
			let result = 0;
			let a = left;
			let b = right;
			while (b > 0) {
				if ((b & 1) === 1) result ^= a;
				a <<= 1;
				if (a > 255) a ^= 285;
				b >>= 1;
			}
			return result;
		}
		/** `2` raised to the `power`-th in GF(256), used to build the generator. */
		function gfPower(power) {
			let value = 1;
			for (let index = 0; index < power; index += 1) value = gfMultiply(value, 2);
			return value;
		}
		function placeCodewords(codewords, version, size, forced) {
			if (forced !== void 0) {
				const matrix = new Matrix(size);
				drawFunctionPatterns(matrix, version);
				drawCodewords(matrix, codewords);
				applyMask(matrix, forced);
				drawFormatBits(matrix, forced);
				return matrix.modules.slice();
			}
			const matrix = new Matrix(size);
			drawFunctionPatterns(matrix, version);
			drawCodewords(matrix, codewords);
			let best;
			let bestScore = Number.POSITIVE_INFINITY;
			for (let mask = 0; mask < 8; mask += 1) {
				const candidate = new Matrix(size);
				drawFunctionPatterns(candidate, version);
				drawCodewords(candidate, codewords);
				applyMask(candidate, mask);
				drawFormatBits(candidate, mask);
				const score = penalty(candidate);
				if (score < bestScore) {
					bestScore = score;
					best = candidate.modules.slice();
				}
			}
			if (best === void 0) throw new Error("QR mask selection produced no candidate");
			return best;
		}
		/** A square of modules with typed access, so the builder reads as coordinates. */
		var Matrix = class {
			size;
			modules;
			/** Which modules are function patterns and must not be masked or overwritten. */
			reserved;
			constructor(size) {
				this.size = size;
				this.modules = new Array(size * size).fill(false);
				this.reserved = new Array(size * size).fill(false);
			}
			get(x, y) {
				return this.modules[y * this.size + x] === true;
			}
			set(x, y, dark) {
				if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
				this.modules[y * this.size + x] = dark;
			}
			mark(x, y) {
				if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
				this.reserved[y * this.size + x] = true;
			}
		};
		/** Finder patterns, separators, timing, alignment, and the dark module. */
		function drawFunctionPatterns(matrix, version) {
			const size = matrix.size;
			for (const [originX, originY] of [
				[0, 0],
				[size - 7, 0],
				[0, size - 7]
			]) for (let y = -1; y <= 7; y += 1) for (let x = -1; x <= 7; x += 1) {
				const px = originX + x;
				const py = originY + y;
				const inside = x >= 0 && x <= 6 && y >= 0 && y <= 6;
				const edge = inside && (x === 0 || x === 6 || y === 0 || y === 6);
				const core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
				matrix.set(px, py, inside && (edge || core));
				matrix.mark(px, py);
			}
			for (let index = 8; index < size - 8; index += 1) {
				const dark = index % 2 === 0;
				matrix.set(index, 6, dark);
				matrix.mark(index, 6);
				matrix.set(6, index, dark);
				matrix.mark(6, index);
			}
			const centres = ALIGNMENT_CENTRES[version - 1];
			for (const centreY of centres) for (const centreX of centres) {
				if (centreX === 6 && centreY === 6 || centreX === 6 && centreY === size - 7 || centreX === size - 7 && centreY === 6) continue;
				for (let y = -2; y <= 2; y += 1) for (let x = -2; x <= 2; x += 1) {
					const dark = Math.max(Math.abs(x), Math.abs(y)) !== 1;
					matrix.set(centreX + x, centreY + y, dark);
					matrix.mark(centreX + x, centreY + y);
				}
			}
			reserveFormatAreas(matrix, version);
			matrix.set(8, size - 8, true);
			matrix.mark(8, size - 8);
		}
		/** Mark the format/version modules as reserved so data never lands on them. */
		function reserveFormatAreas(matrix, version) {
			const size = matrix.size;
			for (let index = 0; index < 9; index += 1) {
				matrix.mark(index, 8);
				matrix.mark(8, index);
			}
			for (let index = 0; index < 8; index += 1) {
				matrix.mark(size - 1 - index, 8);
				matrix.mark(8, size - 1 - index);
			}
			if (version >= 7) for (let y = 0; y < 6; y += 1) for (let x = size - 11; x < size - 8; x += 1) {
				matrix.mark(x, y);
				matrix.mark(y, x);
			}
		}
		/**
		* Walk the symbol in the spec's zigzag — right to left in two-column pairs,
		* alternating upward and downward — placing the codeword bits.
		*/
		function drawCodewords(matrix, codewords) {
			const size = matrix.size;
			let bitIndex = 0;
			let upward = true;
			for (let right = size - 1; right >= 1; right -= 2) {
				if (right === 6) right = 5;
				for (let step = 0; step < size; step += 1) {
					const y = upward ? size - 1 - step : step;
					for (const x of [right, right - 1]) {
						if (matrix.reserved[y * size + x] === true) continue;
						const byte = codewords[bitIndex >> 3];
						const dark = byte === void 0 ? false : (byte >> 7 - (bitIndex & 7) & 1) === 1;
						matrix.set(x, y, dark);
						bitIndex += 1;
					}
				}
				upward = !upward;
			}
		}
		/** XOR the mask pattern over every non-function module. */
		function applyMask(matrix, mask) {
			const size = matrix.size;
			for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
				if (matrix.reserved[y * size + x] === true) continue;
				if (!maskApplies(mask, x, y)) continue;
				matrix.modules[y * size + x] = !matrix.get(x, y);
			}
		}
		/** The eight mask conditions of the spec, by index. */
		function maskApplies(mask, x, y) {
			switch (mask) {
				case 0: return (x + y) % 2 === 0;
				case 1: return y % 2 === 0;
				case 2: return x % 3 === 0;
				case 3: return (x + y) % 3 === 0;
				case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
				case 5: return x * y % 2 + x * y % 3 === 0;
				case 6: return (x * y % 2 + x * y % 3) % 2 === 0;
				case 7: return ((x + y) % 2 + x * y % 3) % 2 === 0;
				default: return false;
			}
		}
		/** Write the format information for `mask` (and the version blocks, if any). */
		function drawFormatBits(matrix, mask) {
			const size = matrix.size;
			const data = 0 | mask;
			let shifted = data << 10;
			for (let index = 14; index >= 10; index -= 1) if ((shifted >> index & 1) === 1) shifted ^= 1335 << index - 10;
			const bits = (data << 10 | shifted) ^ 21522;
			const bit = (index) => (bits >> index & 1) === 1;
			for (let index = 0; index <= 5; index += 1) matrix.set(8, index, bit(index));
			matrix.set(8, 7, bit(6));
			matrix.set(8, 8, bit(7));
			matrix.set(7, 8, bit(8));
			for (let index = 9; index <= 14; index += 1) matrix.set(14 - index, 8, bit(index));
			for (let index = 0; index <= 7; index += 1) matrix.set(size - 1 - index, 8, bit(index));
			for (let index = 8; index <= 14; index += 1) matrix.set(8, size - 15 + index, bit(index));
			matrix.set(8, size - 8, true);
			const version = (size - 17) / 4;
			if (version < 7) return;
			let versionRemainder = version;
			for (let index = 0; index < 12; index += 1) versionRemainder = versionRemainder << 1 ^ (versionRemainder >> 11 & 1) * 7973;
			const versionBits = version << 12 | versionRemainder;
			for (let index = 0; index < 18; index += 1) {
				const dark = (versionBits >> index & 1) === 1;
				const a = Math.floor(index / 3);
				const b = index % 3;
				matrix.set(size - 11 + b, a, dark);
				matrix.set(a, size - 11 + b, dark);
			}
		}
		/** The spec's four penalty rules, summed. Lower is a better mask. */
		function penalty(matrix) {
			const size = matrix.size;
			let score = 0;
			for (let y = 0; y < size; y += 1) {
				let runColour = matrix.get(0, y);
				let runLength = 1;
				for (let x = 1; x < size; x += 1) {
					const colour = matrix.get(x, y);
					if (colour === runColour) runLength += 1;
					else {
						if (runLength >= 5) score += runLength - 2;
						runColour = colour;
						runLength = 1;
					}
				}
				if (runLength >= 5) score += runLength - 2;
			}
			for (let x = 0; x < size; x += 1) {
				let runColour = matrix.get(x, 0);
				let runLength = 1;
				for (let y = 1; y < size; y += 1) {
					const colour = matrix.get(x, y);
					if (colour === runColour) runLength += 1;
					else {
						if (runLength >= 5) score += runLength - 2;
						runColour = colour;
						runLength = 1;
					}
				}
				if (runLength >= 5) score += runLength - 2;
			}
			for (let y = 0; y < size - 1; y += 1) for (let x = 0; x < size - 1; x += 1) {
				const colour = matrix.get(x, y);
				if (colour === matrix.get(x + 1, y) && colour === matrix.get(x, y + 1) && colour === matrix.get(x + 1, y + 1)) score += 3;
			}
			const DARK_LIGHT_RUN = 1488;
			const LIGHT_DARK_RUN = 93;
			for (let y = 0; y < size; y += 1) {
				let across = 0;
				let down = 0;
				for (let index = 0; index < size; index += 1) {
					across = across << 1 & 2047 | (matrix.get(index, y) ? 1 : 0);
					if (index >= 10 && (across === DARK_LIGHT_RUN || across === LIGHT_DARK_RUN)) score += 40;
					down = down << 1 & 2047 | (matrix.get(y, index) ? 1 : 0);
					if (index >= 10 && (down === DARK_LIGHT_RUN || down === LIGHT_DARK_RUN)) score += 40;
				}
			}
			let dark = 0;
			for (const module of matrix.modules) if (module) dark += 1;
			const steps = Math.abs(Math.ceil(dark * 100 / (size * size) / 5) - 10);
			score += steps * 10;
			return score;
		}
		//#endregion
		//#region src/json-value.ts
		/**
		* The one shape predicate every parser in this plugin shares.
		*
		* A decoded JSON value is only safe to index when it is a plain object: `null`
		* is a valid JSON document, an array is one too, and a scalar is one as well.
		* Each of those reaches a `wrapped['field']` read as a TypeError, or worse,
		* silently as `undefined` — so every site that reads a field off parsed text
		* has to say the same thing first. Saying it once here is what keeps a new
		* route, store or decoder from having to remember it.
		*
		* @module dsh-workbuddy-connect/json-value
		*/
		/**
		* Whether a decoded value is a plain JSON object.
		*
		* Arrays are excluded deliberately rather than incidentally: `typeof []`
		* is `'object'`, so a check that forgets them lets a response shaped as a
		* list be indexed by field name.
		*/
		function isJsonObject(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value);
		}
		//#endregion
		//#region src/client/status-document.ts
		/** Reading and shape-checking a product's status document. */
		/**
		* Whether a parsed status response really is a status document.
		*
		* A 200 is not a promise about the body: it may be empty, literal `null`, a
		* non-JSON page from a proxy, or an array. Both halves of the browser plugin
		* read the same route, so both must agree on what is valid — storing an
		* unreadable value puts something in state that the next render dereferences.
		*
		* The check is deliberately limited to the discriminator (plus `error`'s
		* `message`, which the error paragraph renders): validating optional fields
		* here would reject documents the host legitimately omits fields from, which
		* is exactly the shape a host older than the field produces.
		*/
		function isWorkBuddyWebStatus(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
			const wrapped = value;
			const status = wrapped["status"];
			if (status === "signed-out" || status === "signed-in") return true;
			return status === "error" && typeof wrapped["message"] === "string";
		}
		/**
		* Read one product's status document.
		*
		* Every browser-half reader issues the identical request — the variant's own
		* path, `accept: application/json`, same-origin credentials, the caller's abort
		* signal — and every one of them then has to decide what a body that is not a
		* status document means. Both halves of that live here, so a reader only has to
		* state its own degradation policy.
		*
		* @param variant - which product's route to read.
		* @param signal - aborts the request with the caller's lifetime.
		*/
		async function readWorkBuddyStatus(variant, signal) {
			let response;
			try {
				response = await fetch(variant.statusPath, {
					headers: { accept: "application/json" },
					credentials: "same-origin",
					...signal === void 0 ? {} : { signal }
				});
			} catch {
				return { state: "unreadable" };
			}
			const body = await response.json().catch(() => void 0);
			if (!response.ok) return {
				state: "refused",
				message: isJsonObject(body) && typeof body["error"] === "string" ? body["error"] : `HTTP ${String(response.status)}`
			};
			return isWorkBuddyWebStatus(body) ? {
				state: "read",
				status: body
			} : { state: "unreadable" };
		}
		/**
		* One plugin-wide preference, read from whichever document states it.
		*
		* A preference that belongs to the plugin rather than to a product is written to
		* both products' documents, so a reader has to pick one. The pick is not
		* arbitrary: a document that failed to load must not answer for the pair, or one
		* broken route would silently reset a saved preference to its default. So only a
		* document that is a real answer *and* actually states the field counts, and the
		* caller's `read` decides whether the field is stated — which is how a
		* preference whose absent value means "keep it as it was" stays distinguishable
		* from one whose absent value means "off".
		*
		* @param statuses - the latest document per variant id; a variant that never
		*   answered is absent.
		* @param read - pulls this preference out of one answered document.
		* @returns the first stated value, or `undefined` when no document states one.
		*/
		function statedPreference(statuses, read) {
			for (const variant of CARD_VARIANTS) {
				const status = statuses[variant.id];
				if (status === void 0 || status.status === "error") continue;
				const value = read(status);
				if (value !== void 0) return value;
			}
		}
		//#endregion
		//#region src/client/open-external.ts
		/**
		* Whether a URL is one this module will try to open.
		*
		* Mirrors the host's own rule so a bad link is refused before it travels
		* anywhere: only absolute `http` and `https`, never a custom scheme
		* (an app launcher), never `file:`, never `javascript:`.
		*/
		function isExternalWebLink(url) {
			if (typeof url !== "string" || url.trim() === "") return false;
			try {
				const parsed = new URL(url);
				return parsed.protocol === "http:" || parsed.protocol === "https:";
			} catch {
				return false;
			}
		}
		/** Strategy 1: the platform's window-opening API. */
		function viaWindow(win, url) {
			try {
				win.open(url, "_blank", "noopener,noreferrer");
				return true;
			} catch {
				return false;
			}
		}
		/**
		* Strategy 4: an anchor with a blank target, clicked on the spot.
		*
		* Created, clicked and removed inside one call so nothing is left in the DOM,
		* and `display:none` rather than a detached node: a detached anchor's click
		* is ignored by some engines. The element is removed on the next turn rather
		* than synchronously, because the navigation it starts is not complete yet.
		*/
		function viaAnchor(doc, url) {
			try {
				const anchor = doc.createElement("a");
				anchor.href = url;
				anchor.target = "_blank";
				anchor.rel = "noopener noreferrer";
				anchor.style.display = "none";
				(doc.body ?? doc.documentElement).appendChild(anchor);
				anchor.click();
				setTimeout(() => {
					anchor.remove();
				}, 0);
				return true;
			} catch {
				return false;
			}
		}
		/** Strategy 3: DSH's own destination for a link — the right sidebar's browser. */
		function viaSidebar(context, url) {
			if (context === void 0) return false;
			try {
				const tabs = context.get("sidebarRightTabs");
				if (typeof tabs?.get !== "function" || tabs.get("browser") === void 0) return false;
				const sidebar = context.get("sidebarRight");
				if (typeof sidebar?.openTab !== "function") return false;
				sidebar.openTab("browser", {
					params: { url },
					revealIfOpened: true
				});
				return true;
			} catch {
				return false;
			}
		}
		/** Strategy 2: ask the host to hand the link to the operating system. */
		async function viaHost(options, url) {
			const { key, probePath } = options;
			if (key === void 0 || key === "" || probePath === void 0) return false;
			const send = options.fetch ?? globalThis.fetch;
			if (typeof send !== "function") return false;
			try {
				const response = await send(probePath, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-WorkBuddy-Probe-Key": key
					},
					credentials: "same-origin",
					body: JSON.stringify({
						action: "open-link",
						url
					})
				});
				if (!response.ok) return false;
				const value = await response.json().catch(() => void 0);
				return typeof value === "object" && value !== null && value.state === "opened";
			} catch {
				return false;
			}
		}
		/**
		* Open one link, trying every strategy this build has, in order.
		*
		* @returns whether any strategy claimed the link. `false` means every one
		* failed, which is the caller's cue to show the address, not to claim success.
		*/
		async function openExternalLink(url, options = {}) {
			if (!isExternalWebLink(url)) return false;
			const win = typeof window === "undefined" ? void 0 : window;
			const doc = options.document ?? (typeof document === "undefined" ? void 0 : document);
			if (win !== void 0 && viaWindow(win, url)) return true;
			if (await viaHost(options, url)) return true;
			if (viaSidebar(options.context, url)) return true;
			return doc !== void 0 && viaAnchor(doc, url);
		}
		//#endregion
		//#region src/client/model-select.ts
		/**
		* Whether `text` matches `query` as a case-insensitive substring over the
		* model id AND display name. An empty/blank query matches everything.
		*/
		function matchesModelQuery(model, query) {
			const needle = query.trim().toLowerCase();
			if (needle === "") return true;
			return model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle);
		}
		/**
		* Build the dropdown options: the catalog (already in picker order) plus any
		* selected id the catalog no longer carries, flagged stale so the UI can mark
		* it — a saved selection never silently loses an entry, and the user can see
		* which ones went stale upstream.
		*
		* When `query` is non-blank, catalog rows are filtered by
		* {@link matchesModelQuery}; stale rows are kept only while they match too, so
		* a search for a live model does not surface unrelated retired ids.
		*/
		function buildModelSelectOptions(catalog, selected, query = "") {
			const catalogIds = new Set(catalog.map((model) => model.id));
			const options = catalog.filter((model) => matchesModelQuery(model, query)).map((model) => ({
				value: model.id,
				label: model.name,
				stale: false
			}));
			const seen = new Set(catalogIds);
			for (const id of selected) {
				if (id === "" || seen.has(id)) continue;
				seen.add(id);
				if (catalogIds.has(id)) continue;
				if (!matchesModelQuery({
					id,
					name: id
				}, query)) continue;
				options.push({
					value: id,
					label: id,
					stale: true
				});
			}
			return options;
		}
		/**
		* Group dropdown options under headings (`headingOf` maps a model id to its
		* heading, or undefined for ungrouped rows).
		*
		* WorkBuddy has no tiers today, so every caller passes a function that answers
		* `undefined`: the group is then exactly one trailing section, which is what
		* the dropdown renders when it is handed a single group. The mechanism stays
		* because the alternative — an ungrouped flat list with a separate code path —
		* is the thing that has to be rewritten the day the upstream does rank its
		* models. Retired ids always render unheaded (their group is unknowable).
		*/
		function groupModelSelectOptions(options, headingOf) {
			const groups = [];
			const byHeading = /* @__PURE__ */ new Map();
			for (const option of options) {
				const heading = option.stale ? void 0 : headingOf(option.value);
				let group = byHeading.get(heading);
				if (group === void 0) {
					group = {
						heading,
						options: []
					};
					byHeading.set(heading, group);
					groups.push(group);
				}
				group.options.push(option);
			}
			return groups;
		}
		/**
		* Toggle one model id in a selection: remove it when present, append it when
		* absent.
		*
		* A plain set operation with no policy of its own. The "never leave the list
		* empty" rule belongs to the caller, because what an empty list MEANS is the
		* host's answer to give: for WorkBuddy's allowlist an empty list is "no filter"
		* rather than "nothing shown", so the picker refuses the removal instead of
		* writing a list that reopens the whole catalog.
		*/
		function toggleModelSelection(selected, modelId) {
			return selected.includes(modelId) ? selected.filter((value) => value !== modelId) : [...selected, modelId];
		}
		//#endregion
		//#region src/client/model-picker.tsx
		/**
		* The model picker: a searchable checkbox dropdown over one account's catalog.
		*
		* Ported from the Command Code provider's `ModelMultiSelect` +
		* `VisibleModelsRow` (the settings page's model filter), with two changes
		* that are WorkBuddy's rather than the reference's:
		*
		* 1. **The selection means "only show these".** Command Code's picker chooses
		*    which models route to which account; here the list IS the picker filter the
		*    host stores under `uid:enterpriseId`, and an EMPTY selection is "no
		*    filter" rather than "nothing shown". The dropdown therefore refuses to
		*    remove the last remaining entry and marks the row instead — writing an
		*    empty list would silently reopen the whole catalog, which is the opposite
		*    of what the click asked for.
		* 2. **Commits are deferred to close.** A checkbox menu that wrote on every
		*    click would send one host write per tick; the draft is handed over once, on
		*    close, and the owner decides whether that write is immediate (the
		*    per-account editors) or staged for the settings page's save bar.
		*
		* The dropdown's data shaping lives in `model-select.ts` (React-free, so
		* the search/stale/grouping rules are unit-testable without a DOM); this module
		* is only the surface.
		*
		* @module dsh-workbuddy-connect/client/model-picker
		*/
		/**
		* The catalog rows a picker may offer.
		*
		* Only the two fields a dropdown row needs are required: the rest of
		* {@link WorkBuddyWebModelBadge} (rates, context windows, promotions) belongs to
		* the model LIST, and a picker that rendered them would be a second copy of the
		* page. Structural rather than an interface the caller has to satisfy: the page
		* hands over the badges it already has.
		*/
		function selectableModels(models) {
			return (models ?? []).map((model) => ({
				id: model.id,
				name: model.name
			}));
		}
		/**
		* One account's "only show these models" control.
		*
		* @param selected - the committed selection (the host's allowlist, or a staged
		* draft the owner is holding).
		* @param onPick - called once per open/close cycle, only when the set changed.
		*/
		function ModelPicker({ id, selected, labelled, catalog, disabled, label, t, onPick }) {
			const [open, setOpen] = (0, react.useState)(false);
			const [query, setQuery] = (0, react.useState)("");
			/** Ticks made since this menu opened; undefined while nothing is staged. */
			const [draft, setDraft] = (0, react.useState)(void 0);
			const current = draft ?? selected;
			(0, react.useEffect)(() => {
				if (open) setQuery("");
			}, [open]);
			/**
			* Close, committing the draft once.
			*
			* Committed here rather than per click: the reference implementation writes on
			* close for the same reason (one host write per visit instead of one per tick),
			* and the "changed" comparison keeps a look-and-close from sending an
			* identical list back.
			*/
			const close = () => {
				setOpen(false);
				if (draft === void 0) return;
				const next = draft;
				setDraft(void 0);
				if (next.length !== selected.length || next.some((id) => !selected.includes(id))) onPick(next);
			};
			const options = (0, react.useMemo)(() => buildModelSelectOptions(catalog, current, query), [
				catalog,
				current,
				query
			]);
			const items = (0, react.useMemo)(() => groupModelSelectOptions(options, () => void 0), [options]).flatMap((group) => [...group.heading === void 0 ? [] : [{
				type: "label",
				id: `wbp-model-group-${group.heading}`,
				text: group.heading
			}], ...group.options.map((option) => ({
				id: option.value,
				label: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: "wbp-checkRow",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "checkbox",
							className: "wbp-check",
							checked: current.includes(option.value),
							readOnly: true,
							tabIndex: -1
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "wbp-checkName",
							children: option.label
						}),
						option.stale ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "wbp-badge",
							children: t("modelStale")
						}) : null
					]
				})
			}))]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
				open,
				onClose: close,
				onSelect: (modelId) => {
					const next = toggleModelSelection(current, modelId);
					if (next.length === 0) return;
					setDraft(next);
				},
				selectedIds: current,
				items,
				footer: options.length === 0 ? [{
					type: "label",
					id: "wbp-model-search-empty",
					text: t("modelSearchEmpty")
				}] : [],
				portal: true,
				listClassName: "wbp-modelMenu",
				anchor: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: "wbp-modelSelectAnchor",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						id,
						type: "button",
						className: "wbp-selector",
						"aria-haspopup": "menu",
						"aria-expanded": open,
						"aria-label": label,
						disabled: disabled || catalog.length === 0,
						onClick: () => {
							if (open) close();
							else setOpen(true);
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "wbp-selectorText",
							children: (labelled ?? current).length === 0 ? t("modelPick") : t("modelPickCount", { count: (labelled ?? current).length })
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "wbp-selectorCaret",
							"aria-hidden": "true"
						})]
					}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						type: "search",
						className: "wbp-input wbp-modelSearch",
						placeholder: t("modelSearchPlaceholder"),
						"aria-label": t("modelSearchPlaceholder"),
						value: query,
						disabled,
						autoFocus: true,
						onChange: (event) => {
							setQuery(event.target.value);
						}
					}) : null]
				})
			});
		}
		//#endregion
		//#region src/client/account-summary.ts
		/**
		* How rotation reads this account right now.
		*
		* Precedence is the pool's own, restated once so no surface can disagree: an
		* account switched off is off whatever else is true, a judged-dead session is a
		* failure, a live bench is a warning, and a lapsed pasted token is a failure the
		* user has to act on.
		*
		* A bench states the REASON only. The countdown belongs to the meta line, which
		* already says when the allowance returns; stating it in both places made a
		* benched row read "rate limited" over "resets in 7 min" twice.
		*/
		function accountSummaryState(account, now, copy) {
			if (account.enabled !== true) return {
				tone: "off",
				text: copy.disabled,
				servable: false
			};
			if (account.sessionDead === true) return {
				tone: "error",
				text: copy.sessionDead,
				servable: false
			};
			const cooldown = account.cooldown;
			if (cooldown !== void 0 && cooldown.untilMs > now) {
				const wait = waitText(cooldown.untilMs, now, copy);
				if (cooldown.reason === "session") return {
					tone: "warn",
					text: copy.sessionDead,
					servable: false
				};
				return {
					tone: "warn",
					text: cooldown.reason === "credit" ? `${copy.exhausted} · ${wait}` : wait,
					servable: false
				};
			}
			if (account.expiresAtMs > 0 && account.expiresAtMs <= now && account.renewable !== true) return {
				tone: "error",
				text: copy.expired,
				servable: false
			};
			return {
				tone: "ok",
				text: "",
				servable: account.available
			};
		}
		/**
		* The grey line under an account's name: remaining / used / requests / token
		* counts / cache hit / when the allowance returns.
		*
		* Every piece is conditional on the document actually carrying the fact. A
		* balance that was never read is NAMED rather than omitted — it is the one state
		* the reader can act on (press Refresh) — while a request tally of zero is
		* omitted, because "no traffic yet" changes nothing they would do.
		*
		* The join is a middot: the line is one sentence of small figures, not a table,
		* and the separator is what keeps it readable when it wraps.
		*/
		function accountSummaryMeta(account, now, copy) {
			const parts = [];
			const credit = account.credits;
			if (credit === void 0) parts.push(account.creditsError === void 0 ? copy.creditsPending : copy.creditsFailed);
			else if (account.creditsTotal !== void 0 && account.creditsTotal > 0) parts.push(copy.remainingOf({
				remaining: formatCredit$1(credit),
				total: formatCredit$1(account.creditsTotal)
			}));
			else parts.push(copy.remaining({ remaining: formatCredit$1(credit) }));
			if (account.creditsUsed !== void 0) parts.push(copy.used({ used: formatCredit$1(account.creditsUsed) }));
			const usage = account.usage;
			if (usage !== void 0 && usage.requests > 0) {
				parts.push(copy.requests({ count: String(usage.requests) }));
				if (usage.reported > 0) {
					parts.push(copy.inputTokens({ value: shortTokens(usage.promptTokens) }));
					parts.push(copy.outputTokens({ value: shortTokens(usage.completionTokens) }));
					if (usage.cacheHitRate !== void 0) parts.push(copy.cache({ percent: `${(usage.cacheHitRate * 100).toFixed(1)}%` }));
				}
			}
			if (account.creditsResetAtMs !== void 0 && account.creditsResetAtMs > now && (account.cooldown === void 0 || account.cooldown.untilMs <= now)) parts.push(copy.resets({ when: waitText(account.creditsResetAtMs, now, copy) }));
			else if (account.expiresAtMs > 0 && account.expiresAtMs > now && account.renewable !== true) parts.push(copy.tokenExpires({ when: waitText(account.expiresAtMs, now, copy) }));
			return parts.join(" · ");
		}
		/** A credit figure, grouped the way every other surface in this plugin groups one. */
		function formatCredit$1(value) {
			return new Intl.NumberFormat(void 0, { maximumFractionDigits: 1 }).format(value);
		}
		/**
		* A token count as the reader should see it: 1M reads better than 1000000.
		*
		* Only exact multiples are compacted. "1.5M" would imply a precision the tally
		* does not have (it is a sum of per-answer figures), and rounding 999,999 up to
		* "1M" would overstate it.
		*/
		function shortTokens(tokens) {
			if (tokens >= 1e6 && tokens % 1e6 === 0) return `${String(tokens / 1e6)}M`;
			if (tokens >= 1e3 && tokens % 1e3 === 0) return `${String(tokens / 1e3)}K`;
			return String(tokens);
		}
		/** A wait, in the unit that reads best, worded by the caller's dictionary. */
		function waitText(untilMs, now, copy) {
			const wait = describeWait(untilMs, now);
			return copy.wait({
				value: wait.value,
				unit: wait.unit
			});
		}
		//#endregion
		//#region src/client/ui-button.tsx
		/**
		* The one action button both WorkBuddy surfaces draw.
		*
		* A thin wrapper over the platform's `Button` (a PLATFORM SEED module the shell
		* provides), so a row's controls are literally the platform's controls rather
		* than a local reimplementation with its own colours and metrics. The wrapper
		* exists to pin the two choices this plugin always makes — compact size, and a
		* destructive member of the family for anything that deletes a stored sign-in.
		*
		* @module dsh-workbuddy-connect/client/ui-button
		*/
		/** Render one action button. */
		function ActionButton({ label, tone, disabled, title, onClick }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
				variant: tone === "primary" ? "primary" : "ghost",
				size: "sm",
				disabled: disabled === true,
				...title === void 0 ? {} : { title },
				...tone === "danger" ? { className: "wbp-dangerButton" } : {},
				onClick,
				children: label
			});
		}
		//#endregion
		//#region src/client/ui-rows.tsx
		/** Join class names, dropping the empty ones. */
		function cx(...values) {
			return values.filter((value) => typeof value === "string" && value !== "").join(" ");
		}
		/**
		* One settings row, laid out like the harness's own General page: the title and
		* description on the left, the control on the right, a hairline between rows.
		*/
		function SettingRow({ title, titleFor, tag, description, error, control, className, controlClassName }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: cx("wbp-row", className),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "wbp-rowText",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "wbp-rowTitleLine",
							children: [titleFor !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								className: "wbp-rowTitle",
								htmlFor: titleFor,
								children: title
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "wbp-rowTitle",
								children: title
							}), tag]
						}),
						error !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "wbp-rowError",
							children: error
						}) : null,
						error === void 0 && description !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "wbp-rowDesc",
							children: description
						}) : null
					]
				}), control !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: cx("wbp-rowControl", controlClassName),
					children: control
				}) : null]
			});
		}
		/** A heading over a run of rows — the page's one grouping device. */
		function SettingsGroup({ title, action, description, children }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "wbp-group",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "wbp-groupHead",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
								className: "wbp-groupTitle",
								children: title
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "wbp-spacer" }),
							action
						]
					}),
					description === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "wbp-groupDesc",
						children: description
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "wbp-rows",
						children
					})
				]
			});
		}
		/**
		* A capsule tag, drawn by the platform's own `Tag`.
		*
		* This used to be a local `<span>` with four hand-painted palettes. The
		* platform atom already ships exactly these capsules (`outline`, `neutral`,
		* tinted `success` / `warning` / `danger`), so delegating keeps the pills the
		* same width, weight and tone as the tags elsewhere in the settings surface —
		* and removes a palette that could drift out of the theme on its own.
		*
		* The tone names are this plugin's (`plain`/`muted`/`warn`/`error`/`ok`)
		* because they say what the caller MEANS; the mapping below is the one place
		* that translates them into the platform's vocabulary.
		*/
		function Badge({ tone = "plain", title, children }) {
			const tag = /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
				tone: tone === "muted" ? "outline" : tone === "warn" ? "warning" : tone === "error" ? "danger" : tone === "ok" ? "success" : "neutral",
				children
			});
			return title === void 0 ? tag : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				title,
				children: tag
			});
		}
		/** A labelled figure in a filled panel — the dashboard's stat unit. */
		function StatTile({ label, value, sub }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "wbp-usageStat",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "wbp-usageStatLabel",
						children: label
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "wbp-usageStatValue",
						children: value
					}),
					sub === void 0 || sub === "" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "wbp-usageStatSub",
						children: sub
					})
				]
			});
		}
		/**
		* One account's status dot, drawn by the platform's own `StateDot`.
		*
		* The plugin used to paint its own 8px circle here, which meant a hand-rolled
		* palette that had to be kept in step with the harness by hand. `StateDot` is
		* the atom the rest of the settings surfaces use, so the row's mark is the
		* same mark the session list and the job list draw.
		*
		* The mapping is the platform's vocabulary, not this plugin's: an available
		* account is `done`, a benched one `warning`, a refused one `error`, and a
		* switched-off one `idle`.
		*/
		function StatusDot({ tone, title }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				title,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: tone === "ok" ? "done" : tone === "warn" ? "warning" : tone === "error" ? "error" : "idle" })
			});
		}
		/**
		* The quota ring: one glyph serves the rail button, the footer card's head and
		* the dashboard header. A faint track plus an arc whose sweep is the
		* consumption, drawn from 12 o'clock. Circumference 2πr = 45.55 at r = 7.25.
		*/
		function Ring({ percent, warn, size }) {
			const clamped = Math.min(100, Math.max(0, percent));
			const circumference = 45.55;
			const dashoffset = Math.round(circumference * (1 - clamped / 100) * 1e3) / 1e3;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "wbp-glyph",
				"aria-hidden": "true",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
					viewBox: "0 0 20 20",
					width: size,
					height: size,
					focusable: "false",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
						cx: "10",
						cy: "10",
						r: "7.25",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: "1.5",
						opacity: "0.4"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
						cx: "10",
						cy: "10",
						r: "7.25",
						fill: "none",
						stroke: warn ? "var(--dsw-alias-state-error-primary)" : "currentColor",
						strokeWidth: "2.5",
						strokeLinecap: "round",
						strokeDasharray: String(circumference),
						strokeDashoffset: String(dashoffset),
						transform: "rotate(-90 10 10)"
					})]
				})
			});
		}
		/**
		* The platform's segmented control: a translucent track with one raised pill
		* sliding under the picked segment.
		*
		* The indicator's width and offset are computed arithmetically from the count
		* and the index (two custom properties), so it slides without measuring the
		* DOM — the platform's own technique.
		*/
		function SegmentedField({ label, value, options, disabled, onChange, className }) {
			const index = Math.max(0, options.findIndex((option) => option.value === value));
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: cx("wbp-segmented", className),
				role: "radiogroup",
				"aria-label": label,
				style: {
					"--wbp-segment-count": options.length,
					"--wbp-segment-index": index
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "wbp-segmentIndicator",
					"aria-hidden": "true"
				}), options.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					role: "radio",
					"aria-checked": value === option.value,
					className: "wbp-segment",
					disabled: disabled === true,
					...option.title === void 0 ? {} : { title: option.title },
					onClick: () => {
						if (value !== option.value) onChange(option.value);
					},
					children: option.label
				}, option.value))]
			});
		}
		/** A switch row: the platform Switch's shape, as a labelled control. */
		function ToggleField({ id, checked, disabled, label, onChange }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
				id,
				className: "wbp-toggle",
				type: "checkbox",
				role: "switch",
				"aria-label": label,
				checked,
				disabled: disabled === true,
				onChange: (event) => {
					onChange(event.target.checked);
				}
			});
		}
		/**
		* The "only show the ones I pick" control: the value editor, a switch, a count,
		* and a way back.
		*
		* Modelled on the reference implementation's visible-models row
		* (`VisibleModelsRow` in the Command Code provider): the assignment editor
		* sits in the row's control column, and the switch beside it decides whether
		* that assignment reaches the picker at all. Off is "show everything", on is
		* "show what I picked", and turning it off clears the filter rather than leaving
		* an invisible one behind.
		*
		* The editor arrives through {@link FilterRow.control} rather than being built
		* in: this row owns the switch semantics, not the value's shape — a filter over
		* a checkbox column, a multi-select menu, or a text box all read as the same row.
		*/
		function FilterRow({ id, enabled, label, description, summary, clearLabel, control, disabled, onToggle, onClear }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingRow, {
				title: label,
				titleFor: id,
				description,
				className: "wbp-rowNested",
				control: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					control,
					!enabled ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "wbp-hint",
						children: summary
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "wbp-linkButton",
						disabled: disabled === true,
						onClick: onClear,
						children: clearLabel
					})] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleField, {
						id,
						label,
						checked: enabled,
						disabled: disabled === true,
						onChange: onToggle
					})
				] })
			});
		}
		//#endregion
		//#region src/client/WorkBuddySettingsPage.tsx
		/**
		* The WorkBuddy settings page: every pooled account, for both products, their
		* meters, their model lists, and the filter over each one.
		*
		* Why this is a settings *page* rather than a card in the Plugins tab: the two
		* products together are a resource the user checks and acts on — add an
		* account, see what is left, delete one that lapsed — and that is a destination,
		* not a footnote under a plugin list. The Plugins tab keeps the plugin's own
		* card; this page is where the accounts live.
		*
		* Layout, ported from the reference implementation's settings page
		* (`dsh-commandcode-provider`, whose `section.tsx` this page follows component
		* for component):
		*
		*   [accounts heading]                             [+ Add account]
		*   [account rows: state, ⋮ menu, balance meter, disclosure]
		*   [per-product total credit tiles]
		*   [<product> · Models]                            [Refresh]
		*   [filter row: model picker + switch] [row per model: window, detection]
		*   [sticky save bar, while the model filters are staged]
		*
		* What is WorkBuddy's rather than the reference's, and why:
		*
		* - **two products on one page.** The reference has one provider; here the two
		*   rosters stay separate all the way down — separate pools, separate totals,
		*   separate filters — because a sum across them would be a number that
		*   describes nothing (the credits are not convertible and the accounts are not
		*   interchangeable).
		* - **immediate writes where the reference stages.** Account actions (enable,
		*   test, remove, rename) and per-model detection/context writes go out at once:
		*   they are imperative ("stop using this account now", "probe this model now"),
		*   and staging an imperative behind a save button is how a user ends up staring
		*   at a page that has not done what they asked. The MODEL FILTER is staged, as
		*   the reference stages it — assembling "only these models" is a multi-step
		*   edit whose intermediate states are not decisions.
		* - **a picker trigger that states what the filter applies**, not what the
		*   calendar holds: with the filter off the menu edits the whole catalog (there
		*   is no stored list), while the row must not claim a selection that nothing is
		*   filtering.
		*
		* @module dsh-workbuddy-connect/client/settings-page
		*/
		/**
		* Bind one surface's dictionary to the shared account-summary words.
		*
		* The summary module owns WHICH facts a row states and in what order; the
		* dictionary owns how each is worded. This is the one place the two meet, so a
		* second surface reuses the same facts without copying the formatting.
		*/
		function accountSummaryCopy(t) {
			return {
				disabled: t("accountStateDisabled"),
				sessionDead: t("accountStateSessionDead"),
				exhausted: t("accountStateExhausted"),
				limited: t("accountStateLimited"),
				expired: t("accountExpired"),
				creditsFailed: t("accountCreditsFailed"),
				creditsPending: t("accountCreditsPending"),
				remainingOf: ({ remaining, total }) => t("accountMetaRemainingOf", {
					remaining,
					total
				}),
				remaining: ({ remaining }) => t("accountMetaRemaining", { remaining }),
				used: ({ used }) => t("accountMetaUsed", { used }),
				requests: ({ count }) => t("accountMetaRequests", { count }),
				inputTokens: ({ value }) => t("accountMetaInputTokens", { value }),
				outputTokens: ({ value }) => t("accountMetaOutputTokens", { value }),
				cache: ({ percent }) => t("accountMetaCache", { percent }),
				resets: ({ when }) => t("accountMetaResets", { when }),
				tokenExpires: ({ when }) => t("accountMetaTokenExpires", { when }),
				wait: ({ value, unit }) => t(unit === "hour" ? "waitHours" : "waitMinutes", { value })
			};
		}
		/** How often a QR challenge is checked. */
		const POLL_INTERVAL_MS = 2e3;
		/** How often the page re-reads both products while it is open. */
		const REFRESH_INTERVAL_MS$1 = 6e4;
		/**
		* Where the last answered status documents are cached, per product.
		*
		* The same mechanism the reference implementation this page follows
		* (`@mars-sea/dsh-commandcode-provider`) uses for its own cross-session cache:
		* a namespaced `localStorage` key, read and written through a store that
		* tolerates a missing or throwing storage (private modes, a WebView without one)
		* by yielding nothing and dropping the write.
		*
		* Why the cache exists at all: this page's first paint is a read of the status
		* route, and that route answers only after it has looked up every account's
		* credit against the upstream. On a slow link that is seconds of blank page for
		* figures the browser already had. Cached documents paint immediately, and the
		* live read replaces them when it lands — the same stale-while-revalidate shape,
		* with the screen never showing LESS than it already knew.
		*
		* What is deliberately NOT cached: nothing beyond what the status route already
		* sends to this same origin (no token material — the route never carries any),
		* and nothing that outlives the account it describes. A cache entry is keyed by
		* product and replaced wholesale on every successful read; a stale entry is only
		* ever a starting point, never a value that survives a failed read.
		*/
		const STATUS_CACHE_PREFIX = "dsh-workbuddy-connect-functy/status";
		/** The cache key for one product's document. */
		function statusCacheKey(variantId) {
			return `${STATUS_CACHE_PREFIX}/${variantId}`;
		}
		/**
		* Whether a cached document's `probe.results` entries are all renderable.
		*
		* {@link isWorkBuddyWebStatus} checks only the discriminator, so a stored
		* document can carry a result row whose `efforts` is missing — a shape the
		* renderer dereferences (`result.efforts.length`). The live route cannot
		* produce one (the host's store validates every row it reads), but this cache
		* is shared `localStorage`: a document written by an older build, or by any
		* other client on this origin, is not covered by that guarantee and would crash
		* the first paint, before the live read has any chance to replace it.
		*
		* A row that fails this check drops the WHOLE document rather than the row:
		* the document is a single answer, and keeping a partially-trusted one would
		* let the rest of it be read as though the missing row had never been there.
		*/
		function hasRenderableProbeResults(status) {
			if (status.status !== "signed-in") return true;
			const results = status.probe?.results;
			if (results === void 0) return true;
			return Array.isArray(results) && results.every((result) => result !== null && typeof result === "object" && Array.isArray(result.efforts));
		}
		/** Read one cached document, or `undefined` when there is none to trust. */
		function readCachedStatus(variantId) {
			try {
				const raw = localStorage.getItem(statusCacheKey(variantId));
				if (raw === null) return void 0;
				const parsed = JSON.parse(raw);
				if (!isWorkBuddyWebStatus(parsed)) return void 0;
				return hasRenderableProbeResults(parsed) ? parsed : void 0;
			} catch {
				return;
			}
		}
		/** Remember one document for the next visit; a failed write is simply dropped. */
		function writeCachedStatus(variantId, status) {
			try {
				localStorage.setItem(statusCacheKey(variantId), JSON.stringify(status));
			} catch {}
		}
		/**
		* Paint a QR symbol into a canvas.
		*
		* An integer number of device pixels per module: a fractional scale softens the
		* module edges, which is the one thing that makes a camera struggle to lock on.
		*/
		function QrCanvas({ text, modulePixels }) {
			const ref = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				const canvas = ref.current;
				if (canvas === null) return;
				let code;
				try {
					code = encodeQrCode(text);
				} catch {
					return;
				}
				const ratio = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
				const moduleSize = Math.max(1, Math.floor(modulePixels * ratio / code.size));
				const side = moduleSize * code.size;
				canvas.width = side;
				canvas.height = side;
				canvas.style.width = `${String(Math.round(side / ratio))}px`;
				canvas.style.height = `${String(Math.round(side / ratio))}px`;
				const context = canvas.getContext("2d");
				if (context === null) return;
				context.fillStyle = "#fff";
				context.fillRect(0, 0, side, side);
				context.fillStyle = "#000";
				for (let y = 0; y < code.size; y += 1) for (let x = 0; x < code.size; x += 1) {
					if (code.modules[y * code.size + x] !== true) continue;
					context.fillRect(x * moduleSize, y * moduleSize, moduleSize, moduleSize);
				}
			}, [text, modulePixels]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("canvas", {
				ref,
				role: "img",
				"aria-label": "QR",
				style: { display: "block" }
			});
		}
		/**
		* One pooled account, as one row inside its product's card.
		*
		* The row is deliberately flat: a status dot, the account's name, and ONE grey
		* line of small text under it carrying the facts a reader checks at a glance —
		* what is left, what this cycle consumed, what this plugin has sent through the
		* account, and when the allowance returns. There is no disclosure: every figure
		* used to sit behind a chevron, which turned a page about balances into a list
		* of names with the balances hidden. Anything that is a DECISION (enable, test,
		* rename, remove) lives in the ⋮ menu instead, so nothing in the row has to be
		* expanded to be acted on.
		*
		* The meta line omits what is unknown rather than printing a zero: "the
		* upstream did not report this" and "this is zero" are different answers, and
		* the second one is the kind of wrong-but-plausible figure a reader acts on.
		*/
		function AccountRow$1({ account, busy, now, t, onAction }) {
			const [menuOpen, setMenuOpen] = (0, react.useState)(false);
			/** The inline editor this row has open, if any. */
			const [mode, setMode] = (0, react.useState)(void 0);
			const [label, setLabel] = (0, react.useState)("");
			const copy = accountSummaryCopy(t);
			const { tone, text: stateLabel } = accountSummaryState(account, now, copy);
			const items = [
				{
					id: "toggle",
					label: account.enabled === true ? t("accountDisable") : t("accountEnable"),
					disabled: busy
				},
				{
					id: "test",
					label: t("accountTest"),
					disabled: busy
				},
				{
					type: "separator",
					id: "sep-edit"
				},
				{
					id: "rename",
					label: t("accountRename"),
					disabled: busy
				},
				{
					type: "separator",
					id: "sep-danger"
				},
				{
					id: "remove",
					label: t("accountRemoveAction"),
					disabled: busy,
					danger: true
				}
			];
			const onMenuSelect = (id) => {
				setMenuOpen(false);
				if (id === "toggle") onAction({
					action: "enable",
					id: account.id,
					enabled: account.enabled !== true
				});
				else if (id === "test") onAction({
					action: "test",
					id: account.id
				});
				else if (id === "rename") {
					setLabel(account.name);
					setMode("rename");
				} else if (id === "remove") setMode("remove");
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: cx("wbp-accountRow", account.enabled === true && tone === "ok" && "wbp-accountRowActive"),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "wbp-accountHead",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusDot, {
								tone,
								title: stateLabel
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "wbp-accountName",
								title: account.name,
								children: account.name
							}),
							tone === "ok" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "wbp-usagePlanStatus",
								children: stateLabel
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "wbp-spacer" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
								open: menuOpen,
								onClose: () => {
									setMenuOpen(false);
								},
								onSelect: onMenuSelect,
								items,
								align: "end",
								portal: true,
								anchor: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "wbp-iconButton",
									"aria-label": `${account.name} — ${t("accountActions")}`,
									title: t("accountActions"),
									"aria-haspopup": "menu",
									"aria-expanded": menuOpen,
									onClick: () => {
										setMenuOpen((value) => !value);
									},
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "wbp-kebab",
										"aria-hidden": "true"
									})
								})
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "wbp-accountMeta",
						children: accountSummaryMeta(account, now, copy)
					}),
					mode !== "rename" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "wbp-inlineForm",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "wbp-fieldHead",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "wbp-label",
								children: t("accountRename")
							})
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "wbp-inlineActions",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: "wbp-input",
									value: label,
									placeholder: t("accountRenamePlaceholder"),
									"aria-label": t("accountRename"),
									disabled: busy,
									autoFocus: true,
									onChange: (event) => {
										setLabel(event.target.value);
									}
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "wbp-spacer" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
									label: t("cancel"),
									onClick: () => {
										setMode(void 0);
									}
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
									label: t("accountApply"),
									tone: "primary",
									disabled: busy || label.trim() === "",
									onClick: () => {
										onAction({
											action: "label",
											id: account.id,
											label: label.trim()
										});
										setMode(void 0);
									}
								})
							]
						})]
					}),
					mode !== "remove" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "wbp-confirmBar",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "wbp-confirmText",
							children: t("accountRemoveConfirm", { name: account.name })
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "wbp-dialogActions",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
								label: t("cancel"),
								onClick: () => {
									setMode(void 0);
								}
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
								label: t("accountRemove"),
								tone: "danger",
								disabled: busy,
								onClick: () => {
									onAction({
										action: "remove",
										id: account.id
									});
									setMode(void 0);
								}
							})]
						})]
					})
				]
			});
		}
		/**
		* The promotional chips one model row shows, without saying "free" twice.
		*
		* The upstream's own badge text is shown verbatim rather than translated — it is
		* the product's own wording for its own promotion ("Free now", "限时免费"), and
		* restating it in this plugin's language would be inventing copy for a claim the
		* upstream made.
		*
		* The deduplication exists because a free model can arrive with *both* facts: a
		* badge naming the promotion, and the `free` flag the rate was derived from. The
		* international catalog does exactly that, which rendered "Free now" and "Free"
		* side by side. When a badge already says the model is free, the derived chip is
		* dropped — the badge is the specific claim, and this one is only the summary.
		*/
		function promotionChips(model, freeLabel) {
			const badges = model.badges ?? [];
			const alreadySaysFree = badges.some((badge) => /free/i.test(badge) || badge.includes("免费"));
			return [...badges, ...model.free === true && !alreadySaysFree ? [freeLabel] : []];
		}
		/**
		* The model list for one product: a context-length switch where the upstream
		* declares a choice, and a reasoning-level detection button where the model has
		* levels worth discovering.
		*
		* Both controls are writes and share the key-bearing route the account actions
		* use. Detection sits here rather than only in the composer because it is a
		* property of the model you are looking at — reading down the list with the
		* models in front of you is the moment you notice one has no levels declared,
		* and having to go and pick that model first to fix it was the roundabout part.
		*/
		function ModelsBlock({ variant, status, probe, busy, t, staged, context, onContext, onRefresh, onDetect, onClearProbe, onStage }) {
			const signedIn = status !== void 0 && status.status === "signed-in" ? status : void 0;
			const models = signedIn?.models ?? [];
			const catalog = signedIn?.catalog;
			/**
			* The account bucket the model filter belongs to; undefined renders no
			* filter row at all.
			*
			* Absent for an account with no stable user id: the preference is keyed by
			* `uid:enterpriseId`, so there is no bucket to store it in, and a control
			* that cannot be saved is worse than one that is not offered.
			*/
			const visibility = signedIn?.visibility;
			/**
			* The selection in force for this product: the staged draft when one exists,
			* else what the host reports.
			*
			* The draft is absolute rather than a patch — `allowlist.length === 0` IS the
			* "no filter" state — so there is exactly one source of truth per render and
			* no precedence puzzle between two lists that could disagree.
			*/
			const filterOn = staged !== void 0 ? staged.filterOn : visibility?.allowlist !== void 0;
			/**
			* The selection the picker reads and writes.
			*
			* With the filter ON it is the staged draft or the host's list. With it OFF
			* the host keeps no list — "off" and "everything visible" are the same state —
			* so the menu edits a calendar of the whole catalog, and the first untick
			* there turns the filter on (see the picker's commit below). That is what
			* keeps the menu usable without flipping the switch first, and what stops an
			* untick from hiding the entire catalog through a list that only ever named
			* the one model.
			*
			* The CALENDAR is read-only for the trigger's label ({@link displayed}): while
			* the filter is off nothing is filtered, and a label counting the whole
			* catalog would read as a filter that is on.
			*/
			const pickerSelection = staged !== void 0 ? staged.allowlist : visibility?.allowlist ?? (filterOn ? [] : models.map((model) => model.id));
			/**
			* What the FILTER is currently about, which is what the row's label states.
			*
			* Off is "everything", so the label says nothing about models rather than
			* counting them; on names the count the filter is actually applying.
			*/
			const displayed = filterOn ? pickerSelection : visibility?.allowlist ?? [];
			const format = new Intl.DateTimeFormat(void 0, {
				dateStyle: "short",
				timeStyle: "short"
			});
			/**
			* Which model is waiting for the user to agree to a detection.
			*
			* Detection sends real requests against the user's own quota, so it asks
			* first — inline, in the row the button belongs to, rather than in a modal:
			* the question is one line about the model beside it, and a dialog for that is
			* heavier than the action it guards.
			*/
			const [pending, setPending] = (0, react.useState)();
			(0, react.useEffect)(() => {
				if (pending !== void 0 && !(probe?.candidates ?? []).includes(pending)) setPending(void 0);
			}, [pending, probe?.candidates]);
			const catalogNote = catalog === void 0 ? void 0 : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "wbp-hint",
				children: catalog.source === "live" && catalog.fetchedAt !== void 0 ? t("modelsSourceLive", { time: format.format(new Date(catalog.fetchedAt)) }) : catalog.source === "saved" && catalog.fetchedAt !== void 0 ? t("modelsSourceSaved", { time: format.format(new Date(catalog.fetchedAt)) }) : t("modelsSourceFallback")
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				catalogNote === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "wbp-row wbp-rowFlush",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "wbp-rowText",
						children: catalogNote
					})
				}),
				models.length === 0 || visibility === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FilterRow, {
					id: `wbp-filter-${variant.id}`,
					enabled: filterOn,
					disabled: busy,
					label: t("filterModelsLabel"),
					description: filterOn ? t("filterModelsHint") : t("filterModelsIdle"),
					summary: t("filterModelsCount", {
						ticked: displayed.length,
						total: models.length
					}),
					clearLabel: t("filterModelsClear"),
					onToggle: (next) => {
						onStage({
							filterOn: next,
							allowlist: pickerSelection.length > 0 ? pickerSelection : models.map((model) => model.id)
						});
					},
					onClear: () => {
						onStage({
							filterOn: false,
							allowlist: displayed
						});
					},
					control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelPicker, {
						id: `wbp-filter-models-${variant.id}`,
						selected: pickerSelection,
						labelled: displayed,
						catalog: selectableModels(models),
						disabled: busy,
						label: t("filterModelsLabel"),
						t,
						onPick: (ids) => {
							onStage({
								filterOn: true,
								allowlist: ids
							});
						}
					})
				}),
				signedIn === void 0 && status?.status === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "wbp-rowError",
					role: "status",
					children: status.message
				}) : null,
				models.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingRow, {
					title: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "wbp-hint",
						children: t("modelsEmpty")
					}),
					className: "wbp-rowFlush"
				}) : models.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "wbp-modelRow",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "wbp-modelMain",
							children: [
								!filterOn || models.length === 0 || pickerSelection.includes(model.id) ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "wbp-modelFiltered",
									title: t("filterModelsExcludedHint"),
									"aria-label": t("filterModelsExcludedHint")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "wbp-modelName",
									title: model.name,
									children: model.name
								}),
								promotionChips(model, t("freeModel")).map((chip) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
									tone: "ok",
									children: chip
								}, chip)),
								model.credits === void 0 ? model.rateUnknown === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "wbp-hint",
									children: t("rateUnknown")
								}) : null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "wbp-hint",
									children: t("rate", { rate: model.credits })
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "wbp-modelControl",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "wbp-modelProbeResult",
									children: probe === void 0 || !probe.candidates.includes(model.id) ? null : (() => {
										const result = probe.results.find((entry) => entry.id === model.id);
										if (result === void 0) return null;
										return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
											tone: "ok",
											title: t("probeTooltipVerified", { levels: (result.efforts ?? []).join(" / ") }),
											children: result.validation === "validating" && (result.efforts?.length ?? 0) > 0 ? result.efforts.join(" / ") : t(result.validation === "non-validating" ? "probeResultNotValidating" : "probeResultUnknown")
										});
									})()
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "wbp-modelProbeAction",
									children: probe === void 0 || !probe.candidates.includes(model.id) ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
										label: t((() => {
											return probe.results.find((entry) => entry.id === model.id) === void 0 ? "probeStart" : "probeRedetect";
										})()),
										title: t("probeTooltipIdle", { model: model.name }),
										disabled: busy || probe.running === true,
										onClick: () => {
											setPending(model.id);
										}
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "wbp-modelContext",
									children: model.contextChoices === void 0 || model.contextChoices.length < 2 ? model.contextWindow === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: "wbp-hint",
										children: [
											t("contextHeading"),
											" ",
											shortTokens(model.contextWindow)
										]
									}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SegmentedField, {
										label: `${t("contextLabel")}: ${model.name}`,
										disabled: busy,
										value: String(model.contextChoice ?? model.contextChoices[0] ?? 0),
										options: model.contextChoices.map((length) => ({
											value: String(length),
											label: shortTokens(length),
											title: t("contextSwitchTitle", { size: shortTokens(length) })
										})),
										onChange: (next) => {
											onContext(model.id, Number(next));
										}
									})
								})
							]
						}),
						pending !== model.id ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "wbp-confirmBar",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "wbp-confirmText",
								children: t("probeConfirmBody", { model: model.name })
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "wbp-dialogActions",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
									label: t("cancel"),
									onClick: () => {
										setPending(void 0);
									}
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
									label: t("probeConfirmAction"),
									tone: "primary",
									disabled: busy || probe?.running === true,
									onClick: () => {
										setPending(void 0);
										onDetect(model.id);
									}
								})]
							})]
						})
					]
				}, model.id))
			] });
		}
		/**
		* The model lists, one product at a time.
		*
		* Why one list instead of two stacked ones: the two rosters are long (twenty
		* rows each) and share most of their model ids, so showing both doubled the page
		* height for information a reader consults one product at a time. The switch
		* sits where a reader already looks for the list's controls — left of Refresh,
		* on the heading line — and slides, so flipping between the products reads as
		* changing which list is shown rather than as reloading the page.
		*
		* A segmented control rather than tabs: the two products are the same kind of
		* thing seen alternately, not two destinations. It is the platform's own
		* segmented shape (a raised pill sliding under the selected segment), which is
		* what every other two-way choice in this plugin already uses.
		*/
		function ModelsSection({ variants, statuses, probeFor, busy, t, context, stagedModels, onContext, onRefresh, onDetect, onClearProbe, onStage }) {
			/**
			* Which list is on screen.
			*
			* Seeded with the first product and then left alone: the page keeps the
			* choice for its lifetime, because a reader flipping to the other product is
			* doing a comparison, and a re-render that snapped back would undo it.
			*/
			const [shown, setShown] = (0, react.useState)(variants[0]?.id ?? "");
			const active = variants.find((variant) => variant.id === shown) ?? variants[0];
			const count = (variant) => {
				const status = statuses[variant.id];
				return status !== void 0 && status.status === "signed-in" ? status.models?.length ?? 0 : 0;
			};
			if (active === void 0) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingsGroup, {
				title: t("modelsHeading"),
				action: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [variants.length < 2 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SegmentedField, {
					label: t("modelsSwitchLabel"),
					value: active.id,
					disabled: busy,
					options: variants.map((variant) => ({
						value: variant.id,
						label: variant.appName,
						title: t("modelsSwitchTitle", {
							product: variant.appName,
							count: count(variant)
						})
					})),
					onChange: setShown
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
					label: t("modelsRefresh"),
					disabled: busy,
					onClick: () => {
						onRefresh(active);
					}
				})] }),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelsBlock, {
					variant: active,
					status: statuses[active.id],
					probe: probeFor(active),
					busy,
					t,
					context,
					staged: stagedModels[active.id],
					onContext: (model, length) => {
						onContext(active, model, length);
					},
					onRefresh: () => {
						onRefresh(active);
					},
					onDetect: (model) => {
						onDetect(active, model);
					},
					onClearProbe: () => {
						onClearProbe(active);
					},
					onStage: (next) => {
						onStage(active, next);
					}
				}, active.id)
			});
		}
		/**
		* The account area: one card per product, every account of that product inside
		* the same card.
		*
		* Why one card per product rather than one card per account: an account is a row
		* of the POOL, not a surface of its own. A card per account made a two-account
		* pool look like two features, each with its own border, padding and header, and
		* the figures a reader compares sat in separate frames. One card states the
		* product once, its pool total once, and lists its accounts as rows — the shape
		* every account list in this UI already uses.
		*
		* The products stay apart because their credits are not convertible: a shared
		* total would be a number that describes nothing, and the two pools are never
		* interchangeable.
		*/
		function AccountsSection({ entries, statuses, busy, now, t, onAdd, onAction, onRefreshAll }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(SettingsGroup, {
				title: t("accountHeading"),
				action: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [entries.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
					label: t("accountRefreshAll"),
					disabled: busy,
					title: t("accountRefreshAllHint"),
					onClick: onRefreshAll
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
					label: t("accountAdd"),
					disabled: busy,
					onClick: onAdd
				})] }),
				description: entries.length > 1 ? t("accountRotateHint") : t("accountEmptyHint"),
				children: [
					CARD_VARIANTS.map((variant) => {
						const status = statuses[variant.id];
						if (status === void 0 || status.status !== "error") return null;
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
							className: "wbp-rowError",
							role: "status",
							children: [
								variant.appName,
								": ",
								status.message
							]
						}, variant.id);
					}),
					CARD_VARIANTS.map((variant) => {
						const status = statuses[variant.id];
						if (status === void 0 || status.status !== "signed-in" || status.desktopError === void 0) return null;
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
							className: "wbp-notice",
							role: "status",
							children: [
								variant.appName,
								": ",
								status.desktopError
							]
						}, variant.id);
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "wbp-productCards",
						children: CARD_VARIANTS.map((variant) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ProductAccountsCard, {
							variant,
							accounts: entries.filter((entry) => entry.variant.id === variant.id).map((entry) => entry.account),
							status: statuses[variant.id],
							busy,
							now,
							t,
							onAction: (action) => {
								onAction(variant, action);
							}
						}, variant.id))
					})
				]
			});
		}
		/**
		* One product's pooled accounts, in one card.
		*
		* What the card states, and in which order:
		*
		*   [product name]                       [remaining / capacity]
		*   [status dot] [account name]  [state]              ⋮
		*                [grey line: 剩余 / 已用 / 请求 / token / 恢复]
		*   …
		*
		* The head total is the POOL's, summed over the accounts whose balance was
		* actually read — an account whose lookup failed contributes nothing rather
		* than a zero, because a zero would silently shrink a figure the reader is
		* using to decide whether they need to add another account.
		*
		* A product with no accounts and nothing wrong to report renders nothing: a
		* permanent "no accounts" card for a product the user does not use turns a
		* status list into a reminder.
		*/
		function ProductAccountsCard({ variant, accounts, status, busy, now, t, onAction }) {
			const detail = status === void 0 ? void 0 : status.status === "error" ? status.message : status.status === "signed-out" ? status.reason : void 0;
			if (accounts.length === 0 && detail === void 0) return null;
			const known = accounts.map((account) => account.credits).filter((value) => typeof value === "number");
			const total = known.length === 0 ? void 0 : known.reduce((sum, value) => sum + value, 0);
			const capacity = accounts.length > 0 && accounts.every((account) => account.credits === void 0 || account.creditsTotal !== void 0) ? accounts.reduce((sum, account) => sum + (account.creditsTotal ?? 0), 0) : 0;
			const ready = accounts.filter((account) => account.available).length;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "wbp-productCard",
				"aria-label": variant.appName,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "wbp-productHead",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "wbp-productName",
								children: variant.appName
							}),
							accounts.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "wbp-productCount",
								children: t("cardReady", {
									ready,
									total: accounts.length
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "wbp-spacer" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "wbp-productTotal",
								children: total === void 0 ? accounts.length === 0 ? "" : "—" : capacity > 0 ? t("accountMetaRemainingOf", {
									remaining: formatCredit$1(total),
									total: formatCredit$1(capacity)
								}) : t("accountMetaRemaining", { remaining: formatCredit$1(total) })
							})
						]
					}),
					detail === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "wbp-productDetail",
						children: detail
					}),
					accounts.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "wbp-accountList",
						children: accounts.map((account) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountRow$1, {
							account,
							busy,
							now,
							t,
							onAction
						}, account.id))
					})
				]
			});
		}
		/**
		* One account's check-in state, in one sentence.
		*
		* The record and the run answer different questions, so the line states the
		* record first (when this account last claimed a day) and appends the most
		* recent outcome only when it disagrees — a successful run repeats what the
		* record already says, and saying it twice reads as two separate events.
		*/
		function checkinLine(row, t) {
			const parts = [];
			if (row.day !== void 0) parts.push(t("checkinRowDay", { day: row.day }));
			else parts.push(t("checkinRowNever"));
			if (row.state === "failed") parts.push(t("checkinRowFailed", { reason: row.reason ?? "" }));
			else if (row.state === "skipped") parts.push(t("checkinRowSkipped", { reason: row.reason ?? "" }));
			return parts.join(" · ");
		}
		/** The list a user picks a product from before the login dialog opens. */
		function ProductPicker({ t, onPick, onCancel }) {
			return (0, react_dom.createPortal)(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "wbp-overlay",
				role: "presentation",
				onClick: (event) => {
					if (event.target === event.currentTarget) onCancel();
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "wbp-dialog",
					role: "dialog",
					"aria-modal": "true",
					"aria-label": t("accountAddTitle"),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							className: "wbp-dialogTitle",
							children: t("accountAddTitle")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "wbp-dialogBody",
							children: t("accountAddPickHint")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
							label: t("accountAddCn"),
							onClick: () => {
								onPick(CARD_VARIANTS[0]);
							}
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
							label: t("accountAddAi"),
							onClick: () => {
								onPick(CARD_VARIANTS[1]);
							}
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "wbp-dialogActions",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
								label: t("cancel"),
								onClick: onCancel
							})
						})
					]
				})
			}), document.body);
		}
		/**
		* The save bar's leading mark once there is an outcome: a circled tick or a
		* circled bang, ported from the reference implementation's `SaveBarIcon` (same
		* 16px viewBox, same 1.6 stroke). Drawn rather than a glyph character so it
		* inherits the bar's tone colour and never picks up a font's own metrics.
		*/
		function SaveBarGlyph({ tone }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				viewBox: "0 0 16 16",
				width: "16",
				height: "16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "1.6",
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					cx: "8",
					cy: "8",
					r: "6.5"
				}), tone === "success" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M5.2 8.2l1.9 1.9 3.7-3.9" }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M8 4.8v3.6M8 11.1v.1" })]
			});
		}
		/**
		* The sign-in dialog for one product.
		*
		* Both products offer a browser sign-in and a pasted token. Only the CN product
		* offers the scannable code: the international QR endpoint answers, but there is
		* no app on a phone that completes it, so showing a code would be offering a
		* path that cannot be walked. The international product's browser route is
		* therefore a plain link to its console rather than a QR.
		*
		* The browser route only *starts* a sign-in — it is the console, and the plugin
		* cannot observe what happens there. So the token half is not a fallback for it
		* but its other half: the user signs in on the web, copies the token, and pastes
		* it. The copy says so rather than leaving the two tabs unexplained.
		*/
		function AddAccountDialog({ variant, t, busy, error, onCancel, onSubmitQr, onPollQr, onSubmitToken, onSubmitDesktop, onOpenLink }) {
			const qrSupported = variant.id === "workbuddy";
			const [mode, setMode] = (0, react.useState)(qrSupported ? "qr" : "web");
			const [challenge, setChallenge] = (0, react.useState)();
			/**
			* Whether the last hand-off failed.
			*
			* A hand-off can only fail in one place (the browser route, where the dialog
			* itself asks for the page), and when it does the address has to reach the
			* user: every strategy in the chain is silent by design, so without this the
			* dialog would keep a button that appears to work and does not.
			*/
			const [linkFailed, setLinkFailed] = (0, react.useState)(false);
			const [token, setToken] = (0, react.useState)("");
			const [remaining, setRemaining] = (0, react.useState)(0);
			const stopped = (0, react.useRef)(false);
			/**
			* Whether this dialog has already asked for a challenge.
			*
			* A ref, not the `challenge` state: a failed `add` answers with no challenge
			* at all, so keying the effect on the state alone would re-run it on every
			* render the failure caused, firing `add` in a loop. The dialog asks once per
			* opening and offers the explicit actions below after that.
			*/
			const asked = (0, react.useRef)(false);
			/**
			* Whether this dialog has already tried the desktop option.
			*
			* Same one-shot rule as `asked`: reading the app's file is a real action (it
			* clears any earlier removal), so it happens once per opening and the error
			* below is how a failure is reported.
			*/
			const askedDesktop = (0, react.useRef)(false);
			/**
			* Mint a challenge as soon as a route that needs one is shown.
			*
			* Both routes do: the code route renders the URL as a QR, and the browser
			* route opens it. That is what makes the browser route a real sign-in rather
			* than a link to a marketing page — the `authUrl` the host mints *is* the
			* product's login page, carrying the state the host is already polling.
			*/
			(0, react.useEffect)(() => {
				if (mode !== "qr" && mode !== "web" || asked.current) return;
				asked.current = true;
				stopped.current = false;
				onSubmitQr().then((next) => {
					if (stopped.current || next === void 0) return;
					setChallenge(next);
				});
			}, [mode, onSubmitQr]);
			/**
			* Try the desktop option as soon as it is chosen.
			*
			* Reading the app's own file is fast and local, so a button would only repeat
			* the choice the segment already made; a failure surfaces through `error`
			* below and the user can pick another route.
			*/
			(0, react.useEffect)(() => {
				if (mode !== "desktop" || askedDesktop.current) return;
				askedDesktop.current = true;
				onSubmitDesktop();
			}, [mode, onSubmitDesktop]);
			/**
			* Open the minted login page in the system browser, once.
			*
			* Automatic rather than behind a button: the user already chose "sign in on
			* the web", so making them click again to reach the page that choice names
			* would be asking the same question twice. A ref keeps a re-render from
			* opening a second tab.
			*/
			const opened = (0, react.useRef)(false);
			(0, react.useEffect)(() => {
				if (mode !== "web" || challenge === void 0 || opened.current) return;
				opened.current = true;
				onOpenLink(challenge.authUrl).then((opened) => {
					if (!opened) setLinkFailed(true);
				});
			}, [
				mode,
				challenge,
				onOpenLink
			]);
			(0, react.useEffect)(() => {
				if (challenge === void 0) return;
				setLinkFailed(false);
				setRemaining(Math.max(0, challenge.expiresAtMs - Date.now()));
				const tick = window.setInterval(() => {
					setRemaining(Math.max(0, challenge.expiresAtMs - Date.now()));
				}, 1e3);
				return () => {
					window.clearInterval(tick);
				};
			}, [challenge]);
			(0, react.useEffect)(() => {
				if (challenge === void 0 || stopped.current) return;
				const poll = window.setInterval(() => {
					onPollQr(challenge.state).then((keep) => {
						if (!keep) stopped.current = true;
					});
				}, POLL_INTERVAL_MS);
				return () => {
					window.clearInterval(poll);
				};
			}, [challenge, onPollQr]);
			(0, react.useEffect)(() => {
				const onKey = (event) => {
					if (event.key === "Escape") onCancel();
				};
				window.addEventListener("keydown", onKey);
				return () => {
					window.removeEventListener("keydown", onKey);
				};
			}, [onCancel]);
			(0, react.useEffect)(() => () => {
				stopped.current = true;
			}, []);
			return (0, react_dom.createPortal)(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "wbp-overlay",
				role: "presentation",
				onClick: (event) => {
					if (event.target === event.currentTarget) onCancel();
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "wbp-dialog",
					role: "dialog",
					"aria-modal": "true",
					"aria-label": variant.appName,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							className: "wbp-dialogTitle",
							children: t("accountAddTitle")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "wbp-dialogActions",
							style: { justifyContent: "center" },
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SegmentedField, {
								label: t("accountActionLogin"),
								value: mode,
								options: qrSupported ? [
									{
										value: "qr",
										label: t("accountLoginQr")
									},
									{
										value: "desktop",
										label: t("accountLoginDesktop")
									},
									{
										value: "token",
										label: t("accountLoginToken")
									}
								] : [
									{
										value: "web",
										label: t("accountLoginWeb")
									},
									{
										value: "desktop",
										label: t("accountLoginDesktop")
									},
									{
										value: "token",
										label: t("accountLoginToken")
									}
								],
								onChange: (next) => {
									setMode(next);
								}
							})
						}),
						!linkFailed || challenge === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "wbp-linkFallback",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "wbp-dialogBody",
								children: t("accountOpenLinkFailed")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: "wbp-input",
								readOnly: true,
								value: challenge.authUrl,
								"aria-label": t("accountOpenLink"),
								onFocus: (event) => {
									event.currentTarget.select();
								}
							})]
						}),
						mode === "desktop" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "wbp-dialogBody",
							children: t("accountDesktopBody")
						}), busy ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "wbp-hint",
							children: t("loading")
						}) : null] }) : mode === "qr" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "wbp-dialogBody",
								children: t("accountAddBody")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "wbp-qrFrame",
								children: challenge === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "wbp-hint",
									children: t("loading")
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QrCanvas, {
									text: challenge.authUrl,
									modulePixels: 232
								})
							}),
							challenge === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "wbp-dialogBody",
								children: t("accountAddWaiting", { seconds: Math.ceil(remaining / 1e3) })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "wbp-dialogActions",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
									label: t("accountOpenLink"),
									disabled: challenge === void 0,
									onClick: () => {
										if (challenge === void 0) return;
										onOpenLink(challenge.authUrl).then((opened) => {
											setLinkFailed(!opened);
										});
									}
								})
							})
						] }) : mode === "web" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "wbp-dialogBody",
								children: t("accountWebBody")
							}),
							challenge === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "wbp-hint",
								children: t("loading")
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "wbp-dialogBody",
								children: t("accountWebWaiting", { seconds: Math.ceil(remaining / 1e3) })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "wbp-dialogActions",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
									label: t("accountOpenLink"),
									disabled: challenge === void 0,
									onClick: () => {
										if (challenge === void 0) return;
										onOpenLink(challenge.authUrl).then((opened) => {
											setLinkFailed(!opened);
										});
									}
								})
							})
						] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "wbp-dialogBody",
								children: t("accountTokenBody")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
								className: "wbp-tokenArea",
								value: token,
								placeholder: t("accountTokenPlaceholder"),
								spellCheck: false,
								onChange: (event) => {
									setToken(event.target.value);
								}
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "wbp-dialogActions",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
									label: busy ? t("accountChecking") : t("accountSubmit"),
									tone: "primary",
									disabled: busy || token.trim() === "",
									onClick: () => {
										onSubmitToken(token);
									}
								})
							})
						] }),
						error === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "wbp-rowError",
							children: error
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "wbp-dialogActions",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
								label: t("cancel"),
								onClick: onCancel
							})
						})
					]
				})
			}), document.body);
		}
		/**
		* The page itself: one card, two product blocks.
		*
		* Each product is driven by its own status document, so a failure or a slow
		* answer on one never blocks or blanks the other.
		*/
		function WorkBuddySettingsPage({ t, context, refreshPanel }) {
			const [statuses, setStatuses] = (0, react.useState)(() => {
				const cached = {};
				for (const variant of CARD_VARIANTS) {
					const document = readCachedStatus(variant.id);
					if (document !== void 0) cached[variant.id] = document;
				}
				return cached;
			});
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)();
			const [picking, setPicking] = (0, react.useState)(false);
			const [adding, setAdding] = (0, react.useState)();
			const [now, setNow] = (0, react.useState)(() => Date.now());
			/**
			* Uncommitted model filters, one per product.
			*
			* The settings page collects model edits and writes them on Save, matching the
			* reference implementation's staged form: assembling "only these models" is a
			* multi-step decision (open the picker, search, tick, close), and a page that
			* wrote on every close would put three intermediate filters into the host's
			* store on the way to the one the user meant. A per-product map rather than a
			* single draft because the two products' filters are independent rows on one
			* page, and staging one must not discard the other.
			*
			* Each entry is ABSOLUTE, not a patch: `allowlist.length === 0` is the "no
			* filter" state, so there is no precedence puzzle between the draft and the
			* document.
			*/
			const [stagedModels, setStagedModels] = (0, react.useState)({});
			/** True while the staged edits are being written; the bar says so. */
			const [saving, setSaving] = (0, react.useState)(false);
			/**
			* An informational line about what a save actually did.
			*
			* Not `error`: the old-host path is a downgrade, not a failure — the filter is
			* in force, it is just stored as a hide list. Rendering it as an error would
			* turn the save bar red and (worse) hide the "Saved" acknowledgement that says
			* the write landed.
			*/
			const [notice, setNotice] = (0, react.useState)();
			/** True for the moment after a save landed, which is all the bar needs to say. */
			const [justSaved, setJustSaved] = (0, react.useState)(false);
			const mounted = (0, react.useRef)(true);
			/**
			* The latest documents, readable from a callback that must not re-create
			* itself: `readAll` is a dependency of the polling effect, so rebuilding it on
			* every document would restart the interval on every sweep.
			*/
			const statusesRef = (0, react.useRef)(statuses);
			statusesRef.current = statuses;
			(0, react.useEffect)(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);
			(0, react.useEffect)(() => {
				const tick = window.setInterval(() => {
					setNow(Date.now());
				}, 3e4);
				return () => {
					window.clearInterval(tick);
				};
			}, []);
			/**
			* Let the "Saved" state retire on its own.
			*
			* The bar exists to be noticed and then to get out of the way: a save that
			* landed has nothing left to act on, and a bar that stayed until the next
			* click would sit over the page's last rows for as long as the reader is
			* reading. A timer rather than a dismiss button for the same reason —
			* confirming a confirmation is one interaction too many.
			*/
			(0, react.useEffect)(() => {
				if (!justSaved) return;
				const timer = window.setTimeout(() => {
					setJustSaved(false);
				}, 3e3);
				return () => {
					window.clearTimeout(timer);
				};
			}, [justSaved]);
			const readAll = (0, react.useCallback)(async (signal) => {
				const answers = await Promise.all(CARD_VARIANTS.map(async (variant) => {
					const result = await readWorkBuddyStatus(variant, signal);
					if (result.state === "unreadable") return void 0;
					if (result.state === "refused") return [variant.id, {
						status: "error",
						message: result.message
					}];
					return [variant.id, result.status];
				}));
				if (!mounted.current || signal?.aborted === true) return;
				const next = { ...statusesRef.current };
				for (const answer of answers) {
					if (answer === void 0) continue;
					next[answer[0]] = answer[1];
					writeCachedStatus(answer[0], answer[1]);
				}
				statusesRef.current = next;
				setStatuses(next);
			}, []);
			(0, react.useEffect)(() => {
				const controller = new AbortController();
				readAll(controller.signal);
				const tick = window.setInterval(() => {
					readAll(controller.signal);
				}, REFRESH_INTERVAL_MS$1);
				return () => {
					window.clearInterval(tick);
					controller.abort();
				};
			}, [readAll]);
			/** The control key, which the status documents hand out in both sign-in states. */
			const keyFor = (0, react.useCallback)((variant) => {
				const status = statuses[variant.id];
				return status !== void 0 && "probeKey" in status ? status.probeKey : void 0;
			}, [statuses]);
			/**
			* Why this product cannot be written to right now, in the host's own words.
			*
			* The control key arrives with the status document, so a read that failed (or a
			* signed-out host) leaves the page unable to POST anything. That used to be
			* reported as a bare "request failed" — the reported symptom when adding the
			* international product — even though the host had said exactly what was wrong
			* and the sentence was sitting in the response body.
			*/
			const blockedReason = (0, react.useCallback)((variant) => {
				const status = statuses[variant.id];
				if (status === void 0) return void 0;
				if (status.status === "error") return status.message;
				if (status.status === "signed-out") return status.reason;
			}, [statuses]);
			const run = (0, react.useCallback)(async (variant, action) => {
				const key = keyFor(variant);
				if (key === void 0) {
					setError(blockedReason(variant) ?? t("requestFailed"));
					return;
				}
				const response = await fetch(variant.accountPath, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-WorkBuddy-Probe-Key": key
					},
					credentials: "same-origin",
					body: JSON.stringify(action)
				});
				const value = await response.json().catch(() => void 0);
				if (!response.ok) {
					const message = typeof value === "object" && value !== null && "error" in value ? String(value["error"]) : `HTTP ${String(response.status)}`;
					setError(message);
					return;
				}
				return value;
			}, [keyFor, t]);
			const submitQr = (0, react.useCallback)(async (variant) => {
				setError(void 0);
				setBusy(true);
				try {
					const result = await run(variant, { action: "add" });
					if (result?.challenge === void 0) {
						setError(result?.reason ?? t("requestFailed"));
						return;
					}
					return result.challenge;
				} finally {
					if (mounted.current) setBusy(false);
				}
			}, [run, t]);
			/**
			* Hand one sign-in page to the user's own browser.
			*
			* The chain lives in `open-external`; what this adds is the two facts only
			* the page has — which route serves the product the dialog is open for, and
			* the control key that proves this page was the one the host talked to. A
			* signed-out host hands out no key, so the host strategy is simply skipped and
			* the chain falls through to the browser's own APIs.
			*
			* Returns whether the link was handed off at all, so the dialog can name the
			* address instead of leaving the user with a button that did nothing.
			*/
			const openSignInPage = (0, react.useCallback)(async (variant, url) => {
				const key = keyFor(variant);
				const options = { probePath: variant.probePath };
				if (key !== void 0) options.key = key;
				if (context !== void 0) options.context = context;
				return openExternalLink(url, options);
			}, [context, keyFor]);
			const pollQr = (0, react.useCallback)(async (variant, state) => {
				const result = await run(variant, {
					action: "poll",
					state
				});
				if (result === void 0) return false;
				if (result.state === "waiting") return true;
				if (result.state === "added") {
					setAdding(void 0);
					setError(void 0);
					await readAll();
					return false;
				}
				setError(result.reason ?? t(result.state === "expired" ? "accountQrExpired" : "accountQrInvalid"));
				return false;
			}, [
				readAll,
				run,
				t
			]);
			const submitToken = (0, react.useCallback)(async (variant, token) => {
				setError(void 0);
				setBusy(true);
				try {
					const result = await run(variant, {
						action: "add-cookie",
						token
					});
					if (result === void 0) return false;
					if (result.state !== "added") {
						setError(result.reason ?? t("requestFailed"));
						return false;
					}
					setAdding(void 0);
					await readAll();
					return true;
				} finally {
					if (mounted.current) setBusy(false);
				}
			}, [
				readAll,
				run,
				t
			]);
			const submitDesktop = (0, react.useCallback)(async (variant) => {
				setError(void 0);
				setBusy(true);
				try {
					const result = await run(variant, { action: "adopt-desktop" });
					if (result === void 0) return false;
					if (result.state !== "added") {
						setError(result.reason ?? t("requestFailed"));
						return false;
					}
					setAdding(void 0);
					await readAll();
					return true;
				} finally {
					if (mounted.current) setBusy(false);
				}
			}, [
				readAll,
				run,
				t
			]);
			/**
			* Ask the host to re-fetch this product's model list.
			*
			* Shares the probe route's `refresh` action rather than the account route:
			* the work is a catalog fetch, and that is what the probe route already does.
			*/
			const refreshModels = (0, react.useCallback)((variant) => {
				const key = keyFor(variant);
				if (key === void 0) return;
				setBusy(true);
				setError(void 0);
				fetch(variant.probePath, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-WorkBuddy-Probe-Key": key
					},
					credentials: "same-origin",
					body: JSON.stringify({ action: "refresh" })
				}).then(async (response) => {
					const value = await response.json().catch(() => void 0);
					if (!response.ok) setError(`HTTP ${String(response.status)}`);
					else if (typeof value === "object" && value !== null && "state" in value && value.state === "failed") setError(String(value["reason"] ?? t("requestFailed")));
					await readAll();
				}).catch((cause) => {
					setError(cause instanceof Error ? cause.message : t("requestFailed"));
				}).finally(() => {
					if (mounted.current) setBusy(false);
				});
			}, [
				keyFor,
				readAll,
				t
			]);
			/**
			* Detect one model's reasoning levels.
			*
			* A write on the probe route, beside its `refresh`: the probe endpoint owns
			* detection, and the account route owns the pool. Returns nothing — the
			* re-read afterwards is what updates the row.
			*/
			const probeAction = (0, react.useCallback)((variant, body) => {
				const key = keyFor(variant);
				if (key === void 0) return;
				setBusy(true);
				setError(void 0);
				fetch(variant.probePath, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-WorkBuddy-Probe-Key": key
					},
					credentials: "same-origin",
					body: JSON.stringify(body)
				}).then(async (response) => {
					const value = await response.json().catch(() => void 0);
					if (!response.ok) setError(`HTTP ${String(response.status)}`);
					else if (typeof value === "object" && value !== null && "state" in value && value.state === "unavailable") setError(String(value["reason"] ?? t("requestFailed")));
					await readAll();
				}).catch((cause) => {
					setError(cause instanceof Error ? cause.message : t("requestFailed"));
				}).finally(() => {
					if (mounted.current) setBusy(false);
				});
			}, [
				keyFor,
				readAll,
				t
			]);
			/**
			* Stage one product's model filter, or discard with `undefined`.
			*
			* Staging is pure local state: nothing here talks to the host, which is the
			* point of the save bar. A discard drops this product's entry and leaves the
			* other product's alone.
			*/
			const stageModels = (0, react.useCallback)((variant, next) => {
				setJustSaved(false);
				setError(void 0);
				setNotice(void 0);
				setStagedModels((current) => {
					if (next === void 0) {
						if (!(variant.id in current)) return current;
						const { [variant.id]: _dropped, ...rest } = current;
						return rest;
					}
					return {
						...current,
						[variant.id]: next
					};
				});
			}, []);
			/** Discard every staged model edit, for the bar's Discard. */
			const discardStaged = (0, react.useCallback)(() => {
				setStagedModels({});
				setError(void 0);
				setJustSaved(false);
			}, []);
			/**
			* Re-read every account's balance and state, for every product that has one.
			*
			* One write per variant rather than per account: the host's `refresh-credits`
			* drops that variant's whole cached credit map, so the next status read spends
			* one billing request per account — which is exactly what the user asked for
			* by pressing this, and what the ordinary minute-long sweep deliberately does
			* not do.
			*
			* Only the account section is refreshed. The model catalogs have their own
			* per-product Refresh buttons beside their headings, and folding them in here
			* would make one button answer two different questions (and spend an upstream
			* catalog request nobody asked for).
			*
			* A variant with no key (no document answered, or an older host withholding
			* the control key) is skipped rather than reported as a failure: the page is
			* already saying that product cannot be read, and this button is not the place
			* for a second copy of that sentence.
			*/
			const refreshAllAccounts = (0, react.useCallback)(() => {
				const targets = CARD_VARIANTS.map((variant) => ({
					variant,
					key: keyFor(variant)
				})).filter((target) => target.key !== void 0);
				if (targets.length === 0) {
					setError(t("requestFailed"));
					return;
				}
				setBusy(true);
				setError(void 0);
				setNotice(void 0);
				Promise.all(targets.map(async ({ variant, key }) => {
					try {
						const response = await fetch(variant.accountPath, {
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								"X-WorkBuddy-Probe-Key": key
							},
							credentials: "same-origin",
							body: JSON.stringify({ action: "refresh-credits" })
						});
						const value = await response.json().catch(() => void 0);
						if (!response.ok) return "HTTP " + String(response.status);
						if (typeof value === "object" && value !== null && "state" in value && value.state === "failed") return String(value["reason"] ?? t("requestFailed"));
						return;
					} catch (cause) {
						return cause instanceof Error ? cause.message : t("requestFailed");
					}
				})).then(async (failures) => {
					const first = failures.find((failure) => failure !== void 0);
					if (first !== void 0) setError(first);
					await readAll();
					refreshPanel?.();
				}).catch((cause) => {
					setError(cause instanceof Error ? cause.message : t("requestFailed"));
				}).finally(() => {
					if (mounted.current) setBusy(false);
				});
			}, [
				keyFor,
				readAll,
				refreshPanel,
				t
			]);
			const accountAction = (0, react.useCallback)((variant, action) => {
				setError(void 0);
				setBusy(true);
				run(variant, action).then(async (result) => {
					if (result === void 0) return;
					if (result.state === "failed") setError(result.reason ?? t("requestFailed"));
					else if (action.action === "test" && result.test !== void 0) setError(result.test.ok ? void 0 : `${t("accountTestFailed")}: ${result.test.message}`);
					await readAll();
					refreshPanel?.();
				}).finally(() => {
					if (mounted.current) setBusy(false);
				});
			}, [
				readAll,
				refreshPanel,
				run,
				t
			]);
			/**
			* The preference values this page has just written, before the re-read lands.
			*
			* A write is a round trip plus a full re-read of both products' status routes,
			* and the re-read is the slow half: each route re-reads its pool, and on a
			* cold credit cache that is a billing request per account (measured here at
			* 0.35s for the CN route and 1.3s for the international one). Staging the
			* control's own value locally makes the switch move in the same click, and the
			* document replaces it when it arrives — the same "paint first, confirm after"
			* shape the status cache uses.
			*
			* Only the fields this page OWNS are staged; anything the host computes stays
			* whatever the document says.
			*/
			/**
			* Which product's model list the page shows.
			*
			* The two rosters are long (twenty rows each) and share most of their ids, so
			* stacking them doubled the page for no gain: a reader works on ONE product's
			* list at a time. A switch instead of tabs because the two are the same kind of
			* thing seen alternately, not two destinations.
			*
			* Default follows the pool: the first product that actually has a model list.
			* A product with no models shows its empty state rather than a blank panel.
			*/
			const [modelsShown, setModelsShown] = (0, react.useState)(CARD_VARIANTS[0]?.id ?? "");
			const [writtenPreferences, setWrittenPreferences] = (0, react.useState)({});
			/** The bucket this product's preferences are keyed by, when the document has one. */
			const visibilityAccount = (0, react.useCallback)((variant) => {
				const status = statuses[variant.id];
				return status === void 0 || !("visibility" in status) ? void 0 : status.visibility?.account;
			}, [statuses]);
			/** The catalog rows the document currently publishes for one product. */
			const catalogIds = (0, react.useCallback)((variant) => {
				const status = statuses[variant.id];
				return status === void 0 || !("models" in status) ? [] : (status.models ?? []).map((model) => model.id);
			}, [statuses]);
			/**
			* Replace one product's model filter.
			*
			* A write on the probe route, beside the per-model visibility toggle: the two
			* edit different lists on the host (the hide-list and the allowlist), so one
			* cannot be expressed as the other. The account the document was rendered from
			* travels with the request — the host refuses a write aimed at a different
			* account than the one signed in, which is what keeps a stale page from
			* landing A's filter in B's bucket.
			*
			* Reports WHICH failure it was, because the caller answers them differently: an
			* unrecognized action is a host old enough to predate the feature, and that has
			* a working alternative (the per-model hide list — see {@link applyFilterByHiding});
			* anything else is an error the user has to read.
			*/
			const allowlistAction = (0, react.useCallback)((variant, ids) => {
				const key = keyFor(variant);
				const account = visibilityAccount(variant);
				if (key === void 0 || account === void 0) return Promise.resolve("failed");
				setBusy(true);
				setError(void 0);
				return fetch(variant.probePath, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-WorkBuddy-Probe-Key": key
					},
					credentials: "same-origin",
					body: JSON.stringify({
						action: "set-model-allowlist",
						allowlist: ids,
						account
					})
				}).then(async (response) => {
					const value = await response.json().catch(() => void 0);
					if (!response.ok) {
						setError(response.status === 400 || response.status === 404 ? t("filterModelsUnsupported") : `HTTP ${String(response.status)}`);
						await readAll();
						return response.status === 400 || response.status === 404 ? "unsupported" : "failed";
					}
					if (typeof value === "object" && value !== null && "state" in value && value.state !== "updated") {
						setError(String(value["reason"] ?? t("requestFailed")));
						await readAll();
						return "failed";
					}
					await readAll();
					return "updated";
				}).catch((cause) => {
					setError(cause instanceof Error ? cause.message : t("requestFailed"));
					return "failed";
				}).finally(() => {
					if (mounted.current) setBusy(false);
				});
			}, [
				keyFor,
				readAll,
				t,
				visibilityAccount
			]);
			/**
			* Enforce a filter through the per-model hide list, for a host that does not
			* know the allowlist action.
			*
			* The hide list is the plugin's oldest visibility write and every host build
			* has it, so this is the one way to make the switch work TODAY rather than
			* after a DSH restart. It is a translation, not the same write: `disabled`
			* names what to hide rather than what to keep, so the unticked models are
			* hidden and every ticked one is shown again. Applying the filter twice must
			* be idempotent (it is the same two sets), and the tick list itself is not
			* stored — this host has nowhere to put it — so the selection is derived from
			* the hide list on the next read.
			*
			* Unfiltering (the switch going off) shows every model the catalog names,
			* which is what "show everything" means here.
			*/
			const applyFilterByHiding = (0, react.useCallback)(async (variant, ids) => {
				const key = keyFor(variant);
				const account = visibilityAccount(variant);
				const catalog = catalogIds(variant);
				if (key === void 0 || account === void 0 || catalog.length === 0) return false;
				const keep = new Set(ids);
				const writes = catalog.map((model) => ({
					model,
					visible: keep.has(model)
				}));
				const results = await Promise.all(writes.map(async (write) => {
					try {
						return (await fetch(variant.probePath, {
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								"X-WorkBuddy-Probe-Key": key
							},
							credentials: "same-origin",
							body: JSON.stringify({
								action: "set-model-visibility",
								model: write.model,
								visible: write.visible,
								account
							})
						})).ok;
					} catch {
						return false;
					}
				}));
				await readAll();
				return results.every(Boolean);
			}, [
				catalogIds,
				keyFor,
				readAll,
				visibilityAccount
			]);
			/**
			* Write one plugin-wide sidebar preference.
			*
			* An IMMEDIATE write, unlike the model filter beside it: both of these change
			* how an always-visible surface is drawn, and staging them would leave the
			* sidebar keeping a card (or stating the credit one way) while the control
			* claims the other. The value comes back on the next status read, which is
			* what redraws the card.
			*
			* One helper for all three preferences because they are one wire shape — an
			* action plus its value — and because the failure handling is the part that
			* must not drift between them: a 400/404 means this host does not know the
			* action, and that is the same story whichever control asked.
			*/
			const writeSidebarPreference = (0, react.useCallback)((body, staged) => {
				const variant = CARD_VARIANTS[0];
				const key = variant === void 0 ? void 0 : keyFor(variant);
				if (variant === void 0 || key === void 0) {
					setError(blockedReason(variant ?? CARD_VARIANTS[1]) ?? t("requestFailed"));
					return;
				}
				setWrittenPreferences((current) => ({
					...current,
					...staged
				}));
				setError(void 0);
				setNotice(void 0);
				fetch(variant.probePath, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-WorkBuddy-Probe-Key": key
					},
					credentials: "same-origin",
					body: JSON.stringify(body)
				}).then(async (response) => {
					const value = await response.json().catch(() => void 0);
					if (!response.ok) {
						setError(response.status === 400 || response.status === 404 ? t("sidebarSettingUnsupported") : "HTTP " + String(response.status));
						setWrittenPreferences({});
					} else if (typeof value === "object" && value !== null && "state" in value && value.state !== "updated") {
						setError(String(value["reason"] ?? t("requestFailed")));
						setWrittenPreferences({});
					}
					refreshPanel?.();
				}).catch((cause) => {
					setError(cause instanceof Error ? cause.message : t("requestFailed"));
					setWrittenPreferences({});
				});
			}, [
				blockedReason,
				keyFor,
				readAll,
				refreshPanel,
				t
			]);
			/**
			* Claim one account's daily check-in now.
			*
			* A write that spends a round trip rather than credit, so it needs the same
			* in-process key as the other actions but no confirmation step: the upstream
			* is idempotent, and re-asking after "already" costs nothing.
			*/
			const checkInAccount = (0, react.useCallback)((variant, accountId) => {
				const key = keyFor(variant);
				if (key === void 0) return;
				setBusy(true);
				setError(void 0);
				fetch(variant.probePath, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-WorkBuddy-Probe-Key": key
					},
					credentials: "same-origin",
					body: JSON.stringify({
						action: "check-in",
						account: accountId
					})
				}).then(async (response) => {
					const value = await response.json().catch(() => void 0);
					if (!response.ok) setError("HTTP " + String(response.status));
					else if (typeof value === "object" && value !== null && "state" in value && value.state === "failed") setError(String(value["reason"] ?? t("requestFailed")));
					await readAll();
				}).catch((cause) => {
					setError(cause instanceof Error ? cause.message : t("requestFailed"));
				}).finally(() => {
					if (mounted.current) setBusy(false);
				});
			}, [
				keyFor,
				readAll,
				t
			]);
			/** Toggle the daily check-in preference. */
			const setCheckinAuto = (0, react.useCallback)((enabled) => {
				writeSidebarPreference({
					action: "set-checkin-auto",
					enabled
				}, { checkinAuto: enabled });
			}, [writeSidebarPreference]);
			/** Store the sidebar's credit-line style. */
			const setCreditStyle = (0, react.useCallback)((style) => {
				writeSidebarPreference({
					action: "set-sidebar-credit-style",
					creditStyle: style
				}, { creditStyle: style });
			}, [writeSidebarPreference]);
			/**
			* Show or hide the sidebar's credit card.
			*
			* The one preference on this page that removes a surface rather than
			* reshaping it, which is why the group grows a way into the dashboard while it
			* is off: the card is the plugin's only other route there.
			*/
			const setCreditVisible = (0, react.useCallback)((visible) => {
				writeSidebarPreference({
					action: "set-sidebar-credit-visible",
					enabled: visible
				}, { creditVisible: visible });
			}, [writeSidebarPreference]);
			/**
			* Show or hide the composer dock's credit badge.
			*
			* A separate switch from the sidebar card above because it removes a different
			* surface in a different place: the two are independent by design, and neither
			* implies the other.
			*/
			const setComposerCreditVisible = (0, react.useCallback)((visible) => {
				writeSidebarPreference({
					action: "set-composer-credit-visible",
					enabled: visible
				}, { composerVisible: visible });
			}, [writeSidebarPreference]);
			/**
			* Show or hide the composer's reasoning-detection control.
			*
			* The third composer switch: the badge reports a balance, this control offers
			* to spend credit detecting a model, and the two are separate surfaces a user
			* may want independently.
			*/
			const setProbeControlVisible = (0, react.useCallback)((visible) => {
				writeSidebarPreference({
					action: "set-probe-control-visible",
					enabled: visible
				}, { probeControlVisible: visible });
			}, [writeSidebarPreference]);
			/**
			* Write every staged model filter.
			*
			* All-or-nothing in what it REPORTS rather than in what it sends: each
			* product's write goes out on its own (they are independent rows, and one
			* failing must not silently drop the other), and the bar clears only when
			* every write landed — a half-applied save stays visible as unsaved work
			* instead of leaving the page claiming a state the host does not have.
			*
			* `allowlistAction` already surfaces the refusal (HTTP status, host reason,
			* or the "this host does not know the action" copy for a 400/404), which is
			* what the page's error line renders.
			*/
			const saveStaged = (0, react.useCallback)(() => {
				const entries = CARD_VARIANTS.flatMap((variant) => {
					const staged = stagedModels[variant.id];
					return staged === void 0 ? [] : [{
						variant,
						staged
					}];
				});
				if (entries.length === 0) return;
				setSaving(true);
				setError(void 0);
				setNotice(void 0);
				setJustSaved(false);
				Promise.all(entries.map(async (entry) => {
					const ids = entry.staged.filterOn ? entry.staged.allowlist : [];
					const result = await allowlistAction(entry.variant, ids);
					if (result !== "unsupported") return result === "updated";
					const applied = await applyFilterByHiding(entry.variant, ids);
					if (applied) {
						setError(void 0);
						setNotice(t("filterModelsFallback"));
					}
					return applied;
				})).then((results) => {
					if (!mounted.current) return;
					if (results.every(Boolean)) {
						setStagedModels({});
						setJustSaved(true);
					}
				}).catch((cause) => {
					setError(cause instanceof Error ? cause.message : t("requestFailed"));
				}).finally(() => {
					if (mounted.current) setSaving(false);
				});
			}, [
				allowlistAction,
				applyFilterByHiding,
				stagedModels,
				t
			]);
			/**
			* This product's detection state, when the document carries one.
			*
			* Read off the document rather than narrowed through `status`, for the same
			* reason the account section is: `probe` is optional, and a narrowed union
			* loses it.
			*/
			const probeFor = (0, react.useCallback)((variant) => {
				const status = statuses[variant.id];
				return status === void 0 || !("probe" in status) ? void 0 : status.probe;
			}, [statuses]);
			/**
			* Every product's accounts in one list, each tagged with its product.
			*
			* Tagged rather than looked up later: a row's controls must post to the route
			* of the pool the account actually lives in, and the only thing that decides
			* that is which status document it came from.
			*/
			const taggedAccounts = CARD_VARIANTS.flatMap((variant) => {
				const status = statuses[variant.id];
				if (status === void 0 || !("accounts" in status)) return [];
				return (status.accounts?.accounts ?? []).map((account) => ({
					account,
					variant
				}));
			});
			/**
			* The check-in section, read from whichever document carries one.
			*
			* Both variants answer with their own section, so the page merges them: the
			* preference is plugin-wide (one clock, one switch) while the rows are per
			* pool — a CN account's claim must never stand in for an international one's.
			*/
			const checkinSections = CARD_VARIANTS.flatMap((variant) => {
				const status = statuses[variant.id];
				const section = status === void 0 || !("checkin" in status) ? void 0 : status.checkin;
				return section === void 0 ? [] : [{
					variant,
					section
				}];
			});
			/** The plugin-wide switch, when any document states it. */
			const currentCheckinAuto = writtenPreferences.checkinAuto ?? statedPreference(statuses, (status) => status.checkinAuto);
			/** Whether anything is waiting to be written; the bar's whole condition. */
			const hasStaged = Object.keys(stagedModels).length > 0;
			/**
			* The sidebar style the host reports, when it reports one.
			*
			* Read from whichever document carries it (both variants are told the same
			* value — it is one setting, not a per-product one). Absent on a host that
			* cannot persist the preference, and the row is then not rendered at all: a
			* control that cannot be saved is worse than no control.
			*/
			const currentCreditStyle = writtenPreferences.creditStyle ?? statedPreference(statuses, (status) => status.sidebarCreditStyle);
			/**
			* Whether the host says the sidebar keeps its card, when it says anything.
			*
			* `undefined` — not `true` — when no document carries the field: that is an
			* older host which cannot persist the preference, and the switch is then not
			* rendered at all, exactly like the style row beside it. Once the field IS
			* there, an absent value can no longer stand in for "on": the stored value is
			* what the sidebar draws from, and a page that second-guessed it would lie
			* about the state it is editing.
			*/
			const currentCreditVisible = writtenPreferences.creditVisible ?? statedPreference(statuses, (status) => status.sidebarCreditVisible);
			/**
			* Whether the host says the composer keeps its badge, when it says anything.
			*
			* Same `undefined`-means-older-host reading as the sidebar switch beside it,
			* and the same reason: a control that cannot be saved is worse than no control.
			*/
			const currentComposerCreditVisible = writtenPreferences.composerVisible ?? statedPreference(statuses, (status) => status.composerCreditVisible);
			/** Whether the host says the composer keeps its detection control. */
			const currentProbeControlVisible = writtenPreferences.probeControlVisible ?? statedPreference(statuses, (status) => status.probeControlVisible);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "wbp-section",
				"aria-label": t("accountHeading"),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountsSection, {
						entries: taggedAccounts,
						statuses,
						busy,
						now,
						t,
						onAdd: () => {
							setError(void 0);
							setPicking(true);
						},
						onAction: accountAction,
						onRefreshAll: refreshAllAccounts
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelsSection, {
						variants: CARD_VARIANTS,
						statuses,
						probeFor,
						busy,
						t,
						context,
						stagedModels,
						onContext: (variant, model, length) => {
							accountAction(variant, {
								action: "context",
								model,
								length
							});
						},
						onRefresh: (variant) => {
							refreshModels(variant);
						},
						onDetect: (variant, model) => {
							probeAction(variant, {
								action: "probe",
								model
							});
						},
						onClearProbe: (variant) => {
							probeAction(variant, { action: "clear" });
						},
						onStage: (variant, next) => {
							stageModels(variant, next);
						}
					})] }),
					error === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "wbp-rowError",
						children: error
					}),
					notice === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "wbp-notice",
						role: "status",
						children: notice
					}),
					currentCheckinAuto === void 0 && checkinSections.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(SettingsGroup, {
						title: t("checkinHeading"),
						description: t("checkinHint"),
						children: [currentCheckinAuto === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingRow, {
							title: t("checkinAutoLabel"),
							titleFor: "wbp-checkin-auto",
							description: t("checkinAutoHint"),
							control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleField, {
								id: "wbp-checkin-auto",
								label: t("checkinAutoLabel"),
								checked: currentCheckinAuto,
								disabled: busy,
								onChange: setCheckinAuto
							})
						}), checkinSections.flatMap(({ variant, section }) => section.rows.map((row) => {
							const account = taggedAccounts.find((entry) => entry.variant.id === variant.id && entry.account.id === row.accountId)?.account;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingRow, {
								title: account?.name ?? row.accountId,
								description: checkinLine(row, t),
								control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
									label: t("checkinRunNow"),
									disabled: busy,
									onClick: () => {
										checkInAccount(variant, row.accountId);
									}
								})
							}, `${variant.id}:${row.accountId}`);
						}))]
					}),
					currentCreditVisible === void 0 && currentCreditStyle === void 0 && currentComposerCreditVisible === void 0 && currentProbeControlVisible === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(SettingsGroup, {
						title: t("sidebarStyleHeading"),
						children: [
							currentCreditVisible === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingRow, {
								title: t("sidebarVisibleLabel"),
								titleFor: "wbp-sidebar-visible",
								description: t("sidebarVisibleHint"),
								control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleField, {
									id: "wbp-sidebar-visible",
									label: t("sidebarVisibleLabel"),
									checked: currentCreditVisible,
									disabled: busy,
									onChange: setCreditVisible
								})
							}),
							currentCreditStyle === void 0 || currentCreditVisible === false ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingRow, {
								title: t("sidebarStyleLabel"),
								description: t("sidebarStyleHint"),
								control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SegmentedField, {
									label: t("sidebarStyleLabel"),
									disabled: busy,
									value: currentCreditStyle,
									options: [{
										value: "remaining",
										label: t("sidebarStyleRemaining")
									}, {
										value: "usage",
										label: t("sidebarStyleUsage")
									}],
									onChange: (next) => {
										const style = isWorkBuddySidebarCreditStyle(next) ? next : void 0;
										if (style !== void 0 && style !== currentCreditStyle) setCreditStyle(style);
									}
								})
							}),
							currentComposerCreditVisible === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingRow, {
								title: t("composerVisibleLabel"),
								titleFor: "wbp-composer-visible",
								description: t("composerVisibleHint"),
								control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleField, {
									id: "wbp-composer-visible",
									label: t("composerVisibleLabel"),
									checked: currentComposerCreditVisible,
									disabled: busy,
									onChange: setComposerCreditVisible
								})
							}),
							currentProbeControlVisible === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingRow, {
								title: t("probeControlVisibleLabel"),
								titleFor: "wbp-probe-control-visible",
								description: t("probeControlVisibleHint"),
								control: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleField, {
									id: "wbp-probe-control-visible",
									label: t("probeControlVisibleLabel"),
									checked: currentProbeControlVisible,
									disabled: busy,
									onChange: setProbeControlVisible
								})
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "wbp-saveBarDock",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: cx("wbp-saveBar", error !== void 0 ? "wbp-saveBarError" : justSaved && !hasStaged ? "wbp-saveBarSuccess" : void 0, hasStaged || justSaved || error !== void 0 ? "wbp-saveBarShown" : void 0),
							role: "region",
							"aria-label": t("saveBarSave"),
							"aria-hidden": !(hasStaged || justSaved || error !== void 0),
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "wbp-saveBarIcon",
									"aria-hidden": "true",
									children: !hasStaged && error === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SaveBarGlyph, { tone: "success" }) : error !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SaveBarGlyph, { tone: "error" }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "wbp-saveBarPulse" })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "wbp-saveBarText",
									role: "status",
									"aria-live": "polite",
									children: error !== void 0 ? error : hasStaged ? t("saveBarUnsaved") : justSaved ? t("saveBarSaved") : ""
								}),
								hasStaged ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "wbp-saveBarActions",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "wbp-saveBarButton wbp-saveBarGhost",
										disabled: saving,
										onClick: () => {
											discardStaged();
										},
										children: t("saveBarDiscard")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "wbp-saveBarButton wbp-saveBarPrimary",
										disabled: saving,
										onClick: () => {
											saveStaged();
										},
										children: t(saving ? "saveBarSaving" : "saveBarSave")
									})]
								}) : null
							]
						})
					}),
					picking ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ProductPicker, {
						t,
						onPick: (picked) => {
							setPicking(false);
							setAdding(picked);
						},
						onCancel: () => {
							setPicking(false);
						}
					}) : null,
					adding === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AddAccountDialog, {
						variant: adding,
						t,
						busy,
						...error === void 0 ? {} : { error },
						onCancel: () => {
							setAdding(void 0);
							setError(void 0);
						},
						onSubmitQr: () => submitQr(adding),
						onPollQr: (state) => pollQr(adding, state),
						onSubmitToken: (token) => submitToken(adding, token),
						onSubmitDesktop: () => submitDesktop(adding),
						onOpenLink: (url) => openSignInPage(adding, url)
					})
				]
			});
		}
		//#endregion
		//#region src/client/WorkBuddyProbeControl.tsx
		/**
		* Per-model reasoning-effort entry beside the Composer's model selector.
		*
		* Interaction follows the Fast Mode control `dsh-codex-connect` ships in this
		* same seat, which is the established shape for composer chrome here:
		*
		* - a **static inline label** next to the icon names the feature ("Reasoning
		*   levels"), set smaller and dimmer than the surrounding chrome so it reads as
		*   an annotation on the icon. It never carries state: the verified levels
		*   already appear in the model dropdown (the adapter exposes them as
		*   selectable efforts), so repeating them here would duplicate the real answer
		*   and make the label's width jump as results change.
		* - a **hover/focus tooltip** carries the state and the click's purpose, the way
		*   Fast Mode's tooltip explains its current speed.
		* - the **confirmation** is a small bubble anchored to the control, not a
		*   `window.confirm`. Probing spends real credit, so a confirmation stays — but
		*   it belongs next to the thing it acts on, sized to one line plus two small
		*   buttons.
		*
		* @module dsh-workbuddy-connect/client/probe-control
		*/
		/**
		* The card (and therefore the routes) a selected provider belongs to.
		*
		* The control serves both WorkBuddy providers from one seat, so the provider id
		* is what selects the status and probe endpoints. Returning `undefined` for any
		* other provider is what keeps the icon off every non-WorkBuddy model.
		*/
		function cardVariantFor(provider) {
			return CARD_VARIANTS.find((card) => card.id === provider);
		}
		/** How often the control re-checks state when the window regains focus. */
		const RECONCILE_MS = 6e4;
		const wrapperStyle = {
			display: "inline-flex",
			position: "relative",
			alignItems: "center",
			transform: "translateY(2px)",
			marginRight: -8
		};
		const buttonStyle = {
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			gap: 2,
			height: 30,
			padding: "0 6px",
			border: 0,
			borderRadius: 8,
			background: "transparent",
			color: "var(--dsw-alias-label-secondary)",
			font: "inherit",
			whiteSpace: "nowrap",
			cursor: "pointer"
		};
		/**
		* The inline label. Smaller and dimmer than the surrounding chrome on purpose:
		* it names the feature, so it should read as an annotation attached to the icon
		* rather than compete with the adjacent model selector.
		*/
		const labelStyle = {
			fontSize: 11,
			lineHeight: "16px",
			color: "var(--dsw-alias-label-tertiary)"
		};
		/** Tooltip bubble: the Fast Mode shape (nowrap, one line, above the control). */
		const tooltipStyle = {
			position: "absolute",
			left: "50%",
			bottom: "calc(100% + 8px)",
			zIndex: 1e3,
			transform: "translateX(-50%)",
			padding: "4px 8px",
			borderRadius: 6,
			background: "var(--dsw-specific-tip, #1f2329)",
			boxShadow: "var(--dsw-shadow-lv2)",
			color: "var(--dsw-alias-label-primary, #fff)",
			fontSize: 12,
			lineHeight: "18px",
			whiteSpace: "nowrap",
			pointerEvents: "none"
		};
		/** Confirmation bubble: same anchor, but interactive and allowed to wrap. */
		const confirmStyle = {
			position: "absolute",
			right: 0,
			bottom: "calc(100% + 8px)",
			zIndex: 1001,
			display: "flex",
			flexDirection: "column",
			gap: 8,
			width: 260,
			padding: "10px 12px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 8,
			background: "var(--dsw-alias-bg-layer-1, #fff)",
			boxShadow: "var(--dsw-shadow-lv2)",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 12,
			lineHeight: "18px"
		};
		const confirmRowStyle = {
			display: "flex",
			justifyContent: "flex-end",
			gap: 8
		};
		const confirmButtonStyle = {
			padding: "3px 10px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 6,
			background: "transparent",
			color: "inherit",
			font: "inherit",
			fontSize: 12,
			cursor: "pointer"
		};
		/**
		* Primary action inside the confirmation bubble.
		*
		* The fill and its text colour must come as a pair: `brand-primary` resolves to
		* a light accent in this theme, so hardcoding `color: #fff` on top of it renders
		* white-on-white. `button-primary-fill` + `label-primary-foreground` is the
		* theme's own pair for exactly this, and is what `dsh-codex-connect` uses for
		* the same job.
		*/
		const primaryButtonStyle = {
			...confirmButtonStyle,
			border: "1px solid var(--dsw-alias-button-primary-fill)",
			background: "var(--dsw-alias-button-primary-fill)",
			color: "var(--dsw-alias-label-primary-foreground)"
		};
		/**
		* Result note: a single line + a dismiss button, anchored to the control's
		* right side. Smaller than the confirmation bubble because it carries an
		* *outcome*, not a *decision* — the work is done, the user only has to read
		* and dismiss.
		*/
		const noteStyle = {
			position: "absolute",
			right: 0,
			bottom: "calc(100% + 8px)",
			zIndex: 1001,
			display: "flex",
			alignItems: "center",
			gap: 12,
			padding: "6px 10px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 8,
			background: "var(--dsw-alias-bg-layer-1)",
			boxShadow: "var(--dsw-shadow-lv2)",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 12,
			lineHeight: "18px",
			whiteSpace: "nowrap"
		};
		/**
		* The note's dismiss action. Outlined rather than bare text: inside an already
		* bordered bubble, an unbordered word does not read as something you can click.
		* Matches the outlined pill convention the plugin's other secondary actions use.
		*/
		const noteDismissStyle = {
			padding: "2px 8px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 6,
			background: "transparent",
			color: "var(--dsw-alias-label-secondary)",
			font: "inherit",
			fontSize: 12,
			lineHeight: "18px",
			cursor: "pointer"
		};
		/**
		* The feature's static inline label. Deliberately not a state readout — see the
		* module comment.
		*/
		function useLabel(t) {
			return t("probeLabel");
		}
		/** Pick the model's recorded observation out of the probe section. */
		function resultFor(status, model) {
			if (status.status !== "signed-in") return void 0;
			return status.probe?.results.find((result) => result.id === model);
		}
		/**
		* The one-line tooltip: current state first, then what a click does — the same
		* two-part shape Fast Mode uses.
		*
		* A recorded result outranks a remembered failure. `failed` only means "the last
		* run from this control did not complete"; the host can record a result for the
		* same model at any time (a detection started from the settings card, another
		* conversation, or a finished sweep), and the levels the user paid for are the
		* more useful answer than the stale failure. Failure copy is what remains when
		* there is no result to report.
		*/
		function tooltipText(t, model, state) {
			if (state.busy) return t("probeRunning", { model });
			const result = state.result;
			if (result !== void 0) {
				if (result.validation === "validating" && (result.efforts?.length ?? 0) > 0) return t("probeTooltipVerified", { levels: result.efforts.join(" / ") });
				if (result.validation === "non-validating") return t("probeTooltipNotValidating");
				return t("probeTooltipRetry");
			}
			if (state.failed) return t("probeTooltipRetry");
			return t("probeTooltipIdle", { model });
		}
		/** Model-independent shell: resolves the selection, then delegates per model. */
		function WorkBuddyProbeControl({ directory, t }) {
			const subscribe = (0, react.useCallback)((listener) => directory.subscribe(listener), [directory]);
			const snapshot = (0, react.useCallback)(() => directory.getSnapshot(), [directory]);
			const selection = (0, react.useSyncExternalStore)(subscribe, snapshot, snapshot).current;
			const card = selection == null ? void 0 : cardVariantFor(selection.provider);
			const key = card === void 0 || selection == null ? void 0 : `${card.id}:${selection.model}`;
			return card === void 0 || selection == null || key === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelProbe, {
				model: selection.model,
				card,
				label: useLabel(t),
				t
			}, key);
		}
		function ModelProbe({ model, card, label, t }) {
			const [status, setStatus] = (0, react.useState)();
			const [busy, setBusy] = (0, react.useState)(false);
			const [confirming, setConfirming] = (0, react.useState)(false);
			const [tooltipVisible, setTooltipVisible] = (0, react.useState)(false);
			const [failed, setFailed] = (0, react.useState)(false);
			const [note, setNote] = (0, react.useState)();
			const inFlight = (0, react.useRef)(false);
			const mounted = (0, react.useRef)(false);
			const readSeq = (0, react.useRef)(0);
			const tooltipId = (0, react.useId)();
			const refresh = (0, react.useCallback)(async (signal) => {
				const seq = ++readSeq.current;
				const response = await fetch(card.statusPath, {
					credentials: "same-origin",
					headers: { accept: "application/json" },
					...signal === void 0 ? {} : { signal }
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const value = await response.json().catch(() => void 0);
				if (!isWorkBuddyWebStatus(value)) throw new Error(t("statusResponseInvalid"));
				if (mounted.current && !signal?.aborted && seq === readSeq.current) setStatus(value);
			}, [card.statusPath, t]);
			(0, react.useEffect)(() => {
				mounted.current = true;
				const controller = new AbortController();
				const load = () => {
					refresh(controller.signal).catch(() => {});
				};
				load();
				const timer = window.setInterval(load, RECONCILE_MS);
				window.addEventListener("focus", load);
				return () => {
					mounted.current = false;
					controller.abort();
					window.clearInterval(timer);
					window.removeEventListener("focus", load);
				};
			}, [refresh]);
			const probe = status?.status === "signed-in" ? status.probe : void 0;
			const key = status?.status === "signed-in" ? status.probeKey : void 0;
			const result = status === void 0 ? void 0 : resultFor(status, model);
			const hasResult = probe?.candidates.includes(model) === true || result !== void 0;
			const wanted = status === void 0 || !("probeControlVisible" in status) ? true : status.probeControlVisible !== false;
			const visible = hasResult && wanted;
			(0, react.useEffect)(() => {
				if (result !== void 0) setFailed(false);
			}, [result]);
			(0, react.useEffect)(() => {
				setConfirming(false);
				setNote(void 0);
			}, [model]);
			const detect = async () => {
				if (key === void 0 || inFlight.current || probe?.running === true) return;
				inFlight.current = true;
				setNote(void 0);
				setConfirming(false);
				setBusy(true);
				setFailed(false);
				try {
					const response = await fetch(card.probePath, {
						method: "POST",
						credentials: "same-origin",
						headers: {
							"Content-Type": "application/json",
							"X-WorkBuddy-Probe-Key": key
						},
						body: JSON.stringify({
							action: "probe",
							model
						})
					});
					const body = await response.json();
					if (!response.ok || body.state !== "ok" || body.validation !== "validating" && body.validation !== "non-validating" || !Array.isArray(body.efforts) || !body.efforts.every((effort) => typeof effort === "string")) throw new Error("probe failed");
					if (mounted.current) {
						const completed = {
							id: model,
							name: model,
							validation: body.validation,
							efforts: body.efforts,
							probedAt: Date.now()
						};
						setNote(completed);
					}
					refresh().catch(() => {});
				} catch {
					if (mounted.current) setFailed(true);
				} finally {
					inFlight.current = false;
					if (mounted.current) setBusy(false);
				}
			};
			if (!visible) return null;
			const text = tooltipText(t, model, {
				busy,
				result,
				failed
			});
			const disabled = busy || probe?.running === true || key === void 0;
			const showTooltip = tooltipVisible && !confirming && note === void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				style: wrapperStyle,
				onMouseEnter: () => {
					setTooltipVisible(true);
				},
				onMouseLeave: () => {
					setTooltipVisible(false);
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						"aria-label": text,
						"aria-describedby": showTooltip ? tooltipId : void 0,
						"aria-busy": busy,
						"aria-expanded": confirming,
						disabled,
						onClick: () => {
							setConfirming(true);
						},
						onFocus: () => {
							setTooltipVisible(true);
						},
						onBlur: () => {
							setTooltipVisible(false);
						},
						style: {
							...buttonStyle,
							opacity: disabled && !confirming ? .6 : 1,
							cursor: disabled ? "default" : "pointer"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
							width: "16",
							height: "16",
							viewBox: "0 0 24 24",
							fill: "none",
							stroke: "currentColor",
							strokeWidth: "1.6",
							"aria-hidden": "true",
							focusable: "false",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
									cx: "12",
									cy: "12",
									r: "9"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
									cx: "12",
									cy: "12",
									r: "4"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M12 12 20 4" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
									cx: "12",
									cy: "12",
									r: "1"
								})
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: labelStyle,
							children: label
						})]
					}),
					showTooltip && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						id: tooltipId,
						role: "tooltip",
						style: tooltipStyle,
						children: text
					}),
					confirming && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: confirmStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("probeBubbleBody") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: confirmRowStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: confirmButtonStyle,
								onClick: () => {
									setConfirming(false);
								},
								children: t("cancel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: primaryButtonStyle,
								onClick: () => {
									detect();
								},
								children: t("probeConfirmAction")
							})]
						})]
					}),
					note === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						role: "status",
						"aria-live": "polite",
						style: noteStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: noteText(t, note) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: noteDismissStyle,
							onClick: () => {
								setNote(void 0);
							},
							children: t("probeNoteDismiss")
						})]
					})
				]
			});
		}
		/** Compose the one-line outcome string the note bubble shows. */
		function noteText(t, result) {
			if (result.validation === "validating" && (result.efforts?.length ?? 0) > 0) return t("probeNoteVerified", { levels: result.efforts.join(" / ") });
			if (result.validation === "non-validating") return t("probeNoteNotValidating");
			return t("probeNoteUnknown");
		}
		//#endregion
		//#region src/client/panel.ts
		/** Thousands-separated integer, using the reader's own grouping. */
		function formatCount(value) {
			return new Intl.NumberFormat(void 0, { maximumFractionDigits: 0 }).format(value);
		}
		/**
		* Total remaining credit for one product's pool, or undefined when no account
		* reported a balance.
		*
		* Deliberately a SUM over accounts that answered, not over the pool: a pool
		* where one account's lookup failed would otherwise show a figure that silently
		* treats the missing account as zero. Products are never summed together — the
		* two subscriptions' credits are not convertible — which is why this is
		* per-product and there is no grand total anywhere in the view.
		*/
		function creditTotal(accounts) {
			const known = accounts.filter((account) => account.credits !== void 0);
			if (known.length === 0) return void 0;
			return known.reduce((sum, account) => sum + (account.credits ?? 0), 0);
		}
		/**
		* The pool's stated capacity, summed the same way as {@link creditTotal}.
		*
		* undefined unless EVERY account that reported a balance also reported a cap:
		* a partial sum would understate the pool's size while looking like a complete
		* figure, and the used amount derived from it would be wrong in the direction
		* nobody checks (used = total - remaining would come out too large).
		*/
		function creditCapacity(accounts) {
			const known = accounts.filter((account) => account.credits !== void 0);
			if (known.length === 0) return void 0;
			if (known.some((account) => account.creditsTotal === void 0)) return void 0;
			const capacities = known.map((account) => account.creditsTotal ?? 0);
			if (capacities.every((capacity) => capacity <= 0)) return void 0;
			return capacities.reduce((sum, capacity) => sum + capacity, 0);
		}
		/** Whether an account is benched right now. */
		function isBenched(account, now) {
			return account.cooldown !== void 0 && account.cooldown.untilMs > now;
		}
		/**
		* The single key naming a product's sign-in state.
		*
		* The pool is the authority — "signed in" means *the pool has an account*, not
		* that the desktop app is signed in — so the state is read from the account
		* section the host sends in both states, never inferred from a missing one.
		*/
		function productState(status) {
			if (status === void 0) return "unknown";
			if (status.status === "error") return "error";
			return status.status === "signed-in" ? "signed-in" : "signed-out";
		}
		/** Accounts the document carries, whichever sign-in state it is in. */
		function accountsOf(status) {
			if (status === void 0 || status.status === "error") return [];
			return status.accounts?.accounts ?? [];
		}
		/**
		* The one-line explanation a product shows under its name, when it has one.
		*
		* Precedence is deliberate: a host failure outranks a sign-in reason (it means
		* the plugin could not answer at all), and a sign-in reason outranks the
		* generic signed-out hint (it names the file to fix).
		*/
		function detailOf(status) {
			if (status === void 0) return void 0;
			if (status.status === "error") return status.message;
			return status.status === "signed-out" ? status.reason : void 0;
		}
		/** One product's block, from its own status document. */
		function productView(variant, status, now) {
			const accounts = accountsOf(status);
			const benched = accounts.filter((account) => isBenched(account, now)).length;
			const total = creditTotal(accounts);
			const models = status !== void 0 && status.status === "signed-in" ? status.models ?? [] : [];
			const catalogSource = status !== void 0 && status.status === "signed-in" ? status.catalog?.source ?? "none" : "none";
			const stats = [
				{
					label: "accountCount",
					value: formatCount(accounts.length)
				},
				{
					label: "creditTotal",
					value: total === void 0 ? "" : formatCount(total),
					...total === void 0 ? { pending: "creditPending" } : {}
				},
				{
					label: "modelCount",
					value: formatCount(models.length)
				}
			];
			const capacity = creditCapacity(accounts);
			return {
				id: variant.id,
				name: variant.appName,
				state: productState(status),
				...detailOf(status) === void 0 ? {} : { detail: detailOf(status) },
				stats,
				benched,
				catalogSource,
				accounts,
				...total === void 0 ? {} : { creditsRemaining: total },
				...capacity === void 0 ? {} : { creditsCapacity: capacity }
			};
		}
		/**
		* Project one snapshot into the panel's view.
		*
		* `available` is a fact about the HOST, not about sign-in: with no route
		* answering, the dashboard says so once instead of rendering two products that
		* look signed out for reasons the plugin cannot see.
		*/
		function buildPanelView(options) {
			const { snapshot } = options;
			const now = options.now ?? Date.now();
			const products = CARD_VARIANTS.map((variant) => productView(variant, snapshot.statuses[variant.id], now));
			const accountCount = products.reduce((sum, product) => sum + countOf(product, "accountCount"), 0);
			const modelCount = products.reduce((sum, product) => sum + countOf(product, "modelCount"), 0);
			const benchedCount = products.reduce((sum, product) => sum + product.benched, 0);
			return {
				products,
				footProducts: products.filter((product) => product.state === "signed-in" || countOf(product, "accountCount") > 0),
				loading: snapshot.loading && snapshot.fetchedAt === 0,
				available: snapshot.fetchedAt > 0,
				accountCount,
				benchedCount,
				modelCount,
				footTitle: footTitle(products),
				creditStyle: creditStyleOf(snapshot),
				creditVisible: creditVisibleOf(snapshot),
				composerCreditVisible: composerCreditVisibleOf(snapshot),
				preferencesSettled: snapshot.fetchedAt > 0
			};
		}
		/**
		* The card's display preference, as the host stated it.
		*
		* Read from whichever document carries it (both variants are told the same
		* value — it is one plugin-wide setting, not a per-product one), and any
		* document that cannot state it — an older host, or a read that failed — leaves
		* the default shape in place rather than blanking the card.
		*/
		function creditStyleOf(snapshot) {
			return statedPreference(snapshot.statuses, (status) => status.sidebarCreditStyle) ?? "remaining";
		}
		/**
		* Whether the sidebar keeps its card, as the host stated it.
		*
		* The same shape as {@link creditStyleOf} — one plugin-wide answer read from
		* whichever document carries it — with one deliberate difference: a document
		* that does NOT state it means "present", not "hidden". An older host, a read
		* that failed, or a profile with no settings service must all leave the card
		* exactly where it was; only an explicit `false` takes it away.
		*/
		function creditVisibleOf(snapshot) {
			return statedPreference(snapshot.statuses, (status) => status.sidebarCreditVisible) ?? true;
		}
		/**
		* Whether the composer keeps its credit badge, as the host stated it.
		*
		* Same shape and same "absent means present" default as {@link creditVisibleOf},
		* which is what lets both switches be read by one rule instead of two.
		*/
		function composerCreditVisibleOf(snapshot) {
			return statedPreference(snapshot.statuses, (status) => status.composerCreditVisible) ?? true;
		}
		/** Read one numeric stat back out of a product block. */
		function countOf(product, label) {
			const stat = product.stats.find((candidate) => candidate.label === label);
			if (stat === void 0 || stat.value === "") return 0;
			return Number(stat.value.replace(/\D/gu, "")) || 0;
		}
		/**
		* The footer card's tooltip: the product count plus each product's own state,
		* so the card's accessible name carries the same facts its visible rows do.
		*/
		function footTitle(products) {
			return products.map((product) => product.state === "signed-in" ? product.name + ": " + String(countOf(product, "accountCount")) + "/" + String(countOf(product, "modelCount")) : product.name + ": " + product.state).join(" · ");
		}
		//#endregion
		//#region src/client/credit-badge.tsx
		/**
		* The composer's credit badge — "WorkBuddy: 5,266" at the right of the composer
		* dock — and the per-account breakdown it opens.
		*
		* Why this seat: the composer dock is the row DSH already fills with what the
		* turn cost (the context meter, tokens, cache-hit rate, speed). A credit figure
		* answers the next question — "and how much of my quota is left" — so it belongs
		* in that row, and it is registered LAST in it, which puts it to the right of the
		* context readout instead of among the harness's own figures.
		*
		* Why the click expands: the badge states one pool's total, but an account is
		* what a user acts on. Expanding in place answers "which account, and how much is
		* left on it" without a trip to the settings page.
		*
		* The panel is deliberately a copy of the harness's OWN context popover
		* (ui-conversation's `ContextMeter`) rather than a shape of this plugin's
		* invention, because the two sit in the same row and are opened the same way:
		* the same placement and dismissal primitives (`useAnchoredPosition` above the
		* trigger, `useDismissOnOutsidePointer`, Escape), the same menu material and
		* elevation tokens, the same `min(264px, …)` width, the same header/rows
		* geometry, and the same portal into `document.body` — portalled because the
		* composer's own overflow would otherwise crop an anchored panel at the tool
		* row's edge. A user who has opened the context readout has already seen this
		* panel, so it must not read as a second, slightly different one.
		*
		* Why it is conditional on the model: the figure describes the quota behind the
		* model about to answer. Showing it while another provider is selected would
		* attach a WorkBuddy number to a session that cannot spend it.
		*
		* Three seats are read, and all are checked before anything is rendered:
		*
		* 1. **the session's current model** — through the same `ModelDirectory` store
		*    the reasoning-probe control uses, read with `useSyncExternalStore` so a
		*    model switch re-renders this badge;
		* 2. **the credit itself** — from the panel store both the sidebar card and the
		*    dashboard already poll, so the three surfaces can never disagree about what
		*    is left;
		* 3. **whether the badge is wanted at all** — the plugin-wide preference carried
		*    on the same status documents, read through the panel projection so the
		*    switch and the sidebar card's switch answer a missing field identically.
		*
		* A host that supplies none of them (an older client, or a profile without the
		* composer dock) renders nothing: this is an annotation, never a requirement.
		*
		* @module dsh-workbuddy-connect/client/credit-badge
		*/
		/** One credit figure, grouped the way every other surface in this plugin groups it. */
		function formatCredit(value) {
			return new Intl.NumberFormat(void 0, { maximumFractionDigits: 1 }).format(value);
		}
		/**
		* One account's line inside the panel.
		*
		* An account that reported no balance says so rather than showing a zero: "not
		* read yet" and "this account is empty" are different facts, and only the second
		* is worth acting on.
		*/
		function AccountRow({ account, t }) {
			const name = account.label ?? account.nickname ?? account.name;
			const figure = account.credits === void 0 ? t("accountCreditsPending") : account.creditsTotal === void 0 ? t("accountCreditsOnly", { remaining: formatCredit(account.credits) }) : t("accountCreditsRow", {
				remaining: formatCredit(account.credits),
				total: formatCredit(account.creditsTotal)
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "wbp-badgeRow",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", {
					title: name,
					children: name
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: figure })]
			});
		}
		/**
		* One product's block: its heading, the pool's fill, and one row per account.
		*
		* A product with no accounts renders nothing at all rather than an empty
		* heading: the panel is a statement about the pools the user actually has, and a
		* product nobody signed into has no figures to state. (The sidebar card's own
		* rule, applied here for the same reason.)
		*
		* The bar is drawn only when the pool's capacity can be stated COMPLETELY — the
		* same rule the sidebar card follows, so a fill never implies a total that
		* silently ignores an account whose cap went unreported.
		*/
		function ProductBlock({ product, t }) {
			if (product.accounts.length === 0) return null;
			const remaining = product.creditsRemaining;
			const capacity = product.creditsCapacity;
			const ratio = remaining === void 0 || capacity === void 0 || capacity <= 0 ? void 0 : Math.min(1, Math.max(0, remaining / capacity));
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "wbp-badgeGroup",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "wbp-badgeGroupHead",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "wbp-badgeGroupName",
							children: product.name
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "wbp-badgeGroupTotal",
							children: remaining === void 0 ? t("creditPending") : formatCredit(remaining)
						})]
					}),
					ratio === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "wbp-badgeBar",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "wbp-badgeBarFill",
							style: { width: `${String(ratio * 100)}%` }
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dl", {
						className: "wbp-badgeRows",
						children: product.accounts.map((account) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountRow, {
							account,
							t
						}, account.id))
					})
				]
			});
		}
		/**
		* The badge and its panel.
		*
		* Both stores are read through `useSyncExternalStore` with the same
		* subscribe/snapshot pair the probe control uses, so a model switch and a landed
		* sweep each update the figure in place.
		*/
		function WorkBuddyCreditBadge({ directory, panel, t }) {
			const subscribeDirectory = (0, react.useCallback)((listener) => directory.subscribe(listener), [directory]);
			const readDirectory = (0, react.useCallback)(() => directory.getSnapshot(), [directory]);
			const selection = (0, react.useSyncExternalStore)(subscribeDirectory, readDirectory, readDirectory).current;
			const subscribePanel = (0, react.useCallback)((listener) => panel.subscribe(listener), [panel]);
			const readPanel = (0, react.useCallback)(() => panel.getSnapshot(), [panel]);
			const snapshot = (0, react.useSyncExternalStore)(subscribePanel, readPanel, readPanel);
			const [open, setOpen] = (0, react.useState)(false);
			const rootRef = (0, react.useRef)(null);
			const panelRef = (0, react.useRef)(null);
			const view = buildPanelView({ snapshot });
			const card = selection == null ? void 0 : cardVariantFor(selection.provider);
			const product = card === void 0 ? void 0 : view.products.find((candidate) => candidate.id === card.id);
			const remaining = product?.creditsRemaining;
			const available = card !== void 0 && product !== void 0 && product.state === "signed-in" && remaining !== void 0;
			const position = (0, _deepseek_ai_dsh_client_ui_primitives.useAnchoredPosition)({
				open: open && available,
				anchorRef: rootRef,
				panelRef,
				side: "top",
				gap: 8,
				margin: 12
			});
			(0, _deepseek_ai_dsh_client_ui_primitives.useDismissOnOutsidePointer)(rootRef, open && available, setOpen, panelRef);
			(0, react.useEffect)(() => {
				if (!available && open) setOpen(false);
			}, [available, open]);
			(0, react.useEffect)(() => {
				if (!open || !available || typeof document === "undefined") return;
				const onKeyDown = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("keydown", onKeyDown);
				return () => {
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [available, open]);
			if (!view.preferencesSettled) return null;
			if (!view.composerCreditVisible) return null;
			if (!available) return null;
			const label = t("creditBadgeLabel", {
				product: card.appName,
				remaining: formatCredit(remaining)
			});
			const panelBody = /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "wbp-badgePanel",
				ref: panelRef,
				style: position ?? {
					visibility: "hidden",
					left: 0,
					top: 0
				},
				role: "dialog",
				"aria-label": t("creditBadgePanelTitle"),
				children: view.products.map((candidate) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ProductBlock, {
					product: candidate,
					t
				}, candidate.id))
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: "wbp-creditBadgeRoot",
				ref: rootRef,
				"data-workbuddy-credit-badge": "",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
					label,
					side: "top",
					delayMs: 200,
					disabled: open,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: "wbp-creditBadge",
						"aria-label": label,
						"aria-haspopup": "dialog",
						"aria-expanded": open,
						onClick: () => {
							setOpen((current) => !current);
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "wbp-creditBadgeName",
							children: card.appName
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "wbp-creditBadgeValue",
							children: formatCredit(remaining)
						})]
					})
				}), open ? typeof document === "undefined" ? panelBody : (0, react_dom.createPortal)(panelBody, document.body) : null]
			});
		}
		//#endregion
		//#region src/client/panel-copy.ts
		/**
		* Copy for the WorkBuddy dashboard: the sidebar footer card and the centre
		* column panel.
		*
		* Its own namespace (panel.workbuddy), separate from the settings page's
		* settings.workbuddy, because the panel is not part of the settings page —
		* but it follows the SAME active language: both slots declare this namespace
		* at registration, which is what binds their t seat, and a language switch
		* mints a fresh t that re-renders the surfaces (see panel-view.tsx).
		*
		* @module dsh-workbuddy-connect/client/panel-copy
		*/
		/** Locale namespace the panel's surfaces register under. */
		const PANEL_LOCALE_NS = "panel.workbuddy.functy";
		/** English dictionary; the key domain for both surfaces. */
		const PANEL_COPY_EN = {
			/** Panel title and the sidebar card's own label. */
			nav: "WorkBuddy",
			/** Heading over the per-product account totals. */
			accounts: "Accounts",
			/** Heading over the per-product model figures. */
			models: "Models",
			/** Heading listing the per-product sign-in states. */
			signIn: "Sign-in",
			/** The dashboard's refresh action. */
			refresh: "Refresh",
			/** The dashboard's way back to the Conversation. */
			close: "Close",
			/** Shown while a read is in flight and nothing has arrived yet. */
			loading: "Reading the WorkBuddy pools…",
			/** Shown when nothing has ever been read (no host route answered). */
			unavailable: "The host did not report its pools. Update the plugin, or restart DSH.",
			/**
			* The per-product tile captions, read BESIDE their figures: the tile draws the
			* caption as its small label and the count as its large value.
			*
			* Captions, never placeholders — a value like `'{count}'` here is drawn
			* literally, because nothing fills it: the tile translates the label with no
			* parameters, so only a real caption can render.
			*/
			accountCount: "Accounts",
			/** One product's total remaining credit. */
			creditTotal: "Credit",
			/** A product whose accounts report no balance yet. */
			creditPending: "—",
			/** Models currently served, per product. */
			modelCount: "Models",
			/** Where the served model list came from: a live upstream fetch. */
			sourceLive: "Live",
			/** Where the served model list came from: this account's last saved fetch. */
			sourceSaved: "Saved",
			/** Where the served model list came from: the roster compiled into the plugin. */
			sourceFallback: "Built-in",
			/** The product's pool has an account and can serve requests. */
			signedIn: "Signed in",
			/** No account: the product can serve nothing. */
			signedOut: "Not signed in",
			/** The pool has accounts but none may be used right now. */
			allUnavailable: "All accounts are set aside",
			/** The host reported a failure for this product. */
			failure: "Read failed",
			/** A limit leaves N accounts benched until their stated reset. */
			benched: "{count} set aside",
			/** The card's spend line, laid out as "used / total" like the reference card. */
			creditUsed: "{used} / {total}",
			/** Shown instead when the pool's capacity cannot be stated: the balance alone. */
			creditRemaining: "{remaining} left",
			/**
			* The sidebar card's one line per product: the label names the figure, so the
			* number needs no column header beside it.
			*/
			creditRemainingLabel: "{product} remaining",
			/**
			* The composer badge's text and accessible name: the product, then the balance
			* — "WorkBuddy: 5,266". The colon is the whole label, so the figure never
			* needs a heading above it.
			*/
			creditBadgeLabel: "{product}: {remaining}",
			/**
			* The expanded badge panel's heading and accessible name.
			*
			* A title rather than a bare list because the panel states two pools: without
			* it the rows would read as one account list whose figures do not add up.
			*/
			creditBadgePanelTitle: "Credit by account",
			/** One account's balance, when a cap is known: "5,266 / 10,000 left". */
			accountCreditsRow: "{remaining} / {total} left",
			/** One account's balance, when no cap was stated: "5,266 left". */
			accountCreditsOnly: "{remaining} left",
			/** One account whose balance has not been read (yet, or at all). */
			accountCreditsPending: "Not read yet",
			/** The footer card's accessible name and tooltip. */
			footerLabel: "WorkBuddy — open the dashboard",
			/** The rail icon's accessible name. */
			railLabel: "WorkBuddy dashboard"
		};
		/** Chinese dictionary; every key above, in the same order. */
		const PANEL_COPY_ZH = {
			nav: "WorkBuddy",
			accounts: "账号",
			models: "模型",
			signIn: "登录状态",
			refresh: "刷新",
			close: "关闭",
			loading: "正在读取 WorkBuddy 账号池…",
			unavailable: "宿主未返回账号池。请更新插件或重启 DSH。",
			accountCount: "账号",
			creditTotal: "积分",
			creditPending: "—",
			modelCount: "模型",
			sourceLive: "实时",
			sourceSaved: "已保存",
			sourceFallback: "内置",
			signedIn: "已登录",
			signedOut: "未登录",
			allUnavailable: "全部账号被搁置",
			failure: "读取失败",
			benched: "{count} 个搁置中",
			creditUsed: "{used} / {total}",
			creditRemaining: "剩余 {remaining}",
			/** 侧边栏每行一条：标签自己说明这个数字是什么。 */
			creditRemainingLabel: "{product} 剩余额度",
			/** 聊天框那枚徽标的文字与无障碍名：产品名 + 余额。 */
			creditBadgeLabel: "{product}: {remaining}",
			creditBadgePanelTitle: "各账号额度",
			accountCreditsRow: "剩余 {remaining} / {total}",
			accountCreditsOnly: "剩余 {remaining}",
			accountCreditsPending: "尚未读取",
			footerLabel: "WorkBuddy —— 打开仪表盘",
			railLabel: "WorkBuddy 仪表盘"
		};
		/** Fill {name} placeholders from a parameter record. */
		function interpolate(template, params) {
			return template.replace(/\{(\w+)\}/gu, (match, name) => name in params ? String(params[name]) : match);
		}
		/** English fallback used when a registration carries no locale seat. */
		const panelTextEN = (key, params = {}) => interpolate(PANEL_COPY_EN[key], params);
		/**
		* A translator that prefers the harness's active language and falls back to
		* English per key, so a dictionary missing one string (an older bundle, a
		* partially translated locale) still renders a readable panel.
		*/
		function panelTranslator(t) {
			if (t === void 0) return panelTextEN;
			return (key, params = {}) => {
				const translated = t(key, params);
				return translated === key ? interpolate(PANEL_COPY_EN[key], params) : translated;
			};
		}
		//#endregion
		//#region src/client/panel-hooks.ts
		/**
		* React binding for the shared panel store: the `useSyncExternalStore` seat
		* both panel surfaces read through, plus the two effects that keep the poll
		* alive for exactly as long as a surface is mounted.
		*
		* Kept apart from `panel-view.tsx` so the components stay render-only and the
		* subscription logic has one home.
		*
		* @module dsh-workbuddy-connect/client/panel-hooks
		*/
		/**
		* Run `start` once for the mount, disposing on unmount.
		*
		* The panel's poll is started by the sidebar card (always mounted) rather than
		* by the dashboard, and `start()` is idempotent per store — so opening the
		* dashboard does not start a second timer, and closing it does not stop the
		* card's.
		*/
		function useEffectOnce(start) {
			(0, react.useEffect)(() => start(), [start]);
		}
		//#endregion
		//#region src/client/panel-view.tsx
		/**
		* The panel's view. `useWorkBuddyPanel` subscribes to the shared store, so a
		* completed sweep re-renders BOTH surfaces from the same snapshot — the footer
		* card's totals and the dashboard can never disagree about what was read.
		*/
		function usePanelView(props) {
			return buildPanelView({ snapshot: props.useWorkBuddyPanel((state) => state) });
		}
		/** Resolve the translator once per render from the injected locale seat. */
		function translatorOf(props) {
			return panelTranslator(props.t);
		}
		/** The tag tone a product's sign-in state earns. */
		function stateTone(product) {
			if (product.state === "signed-in") return "success";
			if (product.state === "error") return "danger";
			if (product.state === "signed-out") return "warning";
			return "neutral";
		}
		/** One product's state as words. */
		function stateText(product, t) {
			if (product.state === "signed-in") return t("signedIn");
			if (product.state === "signed-out") return t("signedOut");
			if (product.state === "error") return t("failure");
			return t("loading");
		}
		/**
		* One product on the dashboard: its identity, its state, and its figures.
		*
		* Built from the same row pieces the settings page uses, so the two surfaces are
		* visibly the same product's UI. The block is a `<section>` of rows rather than
		* a card because the reference layout has no card surfaces at all.
		*/
		function ProductCard({ product, t }) {
			const tone = stateTone(product);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "wbp-card",
				"aria-label": product.name,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "wbp-cardHead",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "wbp-avatar",
								"aria-hidden": "true",
								children: product.name.slice(0, 1).toUpperCase()
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "wbp-cardIdentity",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "wbp-cardTitle",
									children: product.name
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "wbp-spacer" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
								tone: tone === "success" ? "plain" : tone === "danger" ? "error" : tone === "warning" ? "warn" : "muted",
								children: stateText(product, t)
							}),
							product.benched > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
								tone: "warn",
								children: t("benched", { count: product.benched })
							}) : null,
							product.catalogSource === "none" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Badge, {
								tone: "muted",
								children: t(product.catalogSource === "live" ? "sourceLive" : product.catalogSource === "saved" ? "sourceSaved" : "sourceFallback")
							})
						]
					}),
					product.detail === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "wbp-noticeHint",
						children: product.detail
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "wbp-tiles",
						children: product.stats.map((stat) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatTile, {
							label: t(stat.label),
							value: stat.value === "" ? stat.pending === void 0 ? "" : t(stat.pending) : stat.value
						}, stat.label))
					})
				]
			});
		}
		/**
		* The centre-column dashboard, registered into the layout's keyed `main` slot
		* under `workbuddy-panel`. Selecting that key is what the footer card's
		* `open()` does, so the two registrations are one navigation entry.
		*
		* The panel covers the Conversation while it is open, which is why it carries
		* its own way back (`close`): without one the footer card could only re-select
		* a panel the user is already looking at.
		*/
		function WorkBuddyPanel(props) {
			const view = usePanelView(props);
			const t = translatorOf(props);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "wbp-main",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "wbp-mainInner",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
							className: "wbp-header",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Ring, {
									percent: ringPercent(view),
									warn: view.benchedCount > 0,
									size: 20
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "wbp-headerText",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
										className: "wbp-titleLg",
										children: t("nav")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "wbp-subtitle",
										children: view.available ? t("footerLabel") : t("unavailable")
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "wbp-spacer" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
									label: t("refresh"),
									onClick: () => {
										props.refresh();
									}
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
									label: t("close"),
									onClick: () => {
										props.close();
									}
								})
							]
						}),
						!view.available && !view.loading ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "wbp-notice wbp-noticeError",
							role: "status",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "wbp-noticeTitle",
								children: t("failure")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "wbp-noticeHint",
								children: t("unavailable")
							})]
						}) : null,
						view.loading ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "wbp-hint",
							children: t("loading")
						}) : null,
						view.available ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "wbp-tiles",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatTile, {
									label: t("accounts"),
									value: String(view.accountCount)
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatTile, {
									label: t("models"),
									value: String(view.modelCount)
								}),
								view.benchedCount === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatTile, {
									label: t("benched", { count: view.benchedCount }),
									value: String(view.benchedCount)
								})
							]
						}) : null,
						view.products.map((product) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ProductCard, {
							product,
							t
						}, product.id))
					]
				})
			});
		}
		/**
		* The header ring's sweep: how much of what the pools hold is servable now.
		*
		* A ring rather than a number because the header has no room for a sentence, and
		* "everything is fine" is the state a glance should confirm. With nothing read
		* yet the ring is empty rather than full, so "nothing known" does not look like
		* "all healthy".
		*/
		function ringPercent(view) {
			if (view.accountCount === 0) return 0;
			return (view.accountCount - view.benchedCount) / view.accountCount * 100;
		}
		/**
		* The sidebar footer card, registered into `sidebar.footer.action` — the list
		* the shell renders in the sidebar's foot area directly ABOVE the Settings
		* seat, so the card reads as a bottom-pinned sibling of Settings rather than a
		* global panel icon at the top of the column.
		*
		* The shell wraps nothing here, so this component owns the surface: the button,
		* its chrome and its accessible name. In the expanded column it draws the title
		* row and one line per product (accounts, total credit, models) — the two
		* products are never merged into one figure, because their credits are not
		* convertible. In the 56px rail it collapses to a 36px icon button, matching the
		* shell's own rail geometry. `wide` arrives from the shell as an owner prop.
		*
		* The poll starts here rather than in the panel: the card is always mounted, so
		* the dashboard opens with data already in hand.
		*
		* The one thing that can take this card away is the user's own switch
		* ({@link PanelView.creditVisible}). The component still MOUNTS when that is
		* off — it renders `null` and keeps the shared poll alive with it. That matters:
		* the poll's home is this entry, and a component that unmounted would leave the
		* dashboard and the composer badge reading a snapshot nothing refreshes.
		*/
		function WorkBuddyFooterEntry(props) {
			const view = usePanelView(props);
			const t = translatorOf(props);
			const startAutoRefresh = props.startAutoRefresh;
			const refresh = props.refresh;
			useEffectOnce(startAutoRefresh);
			if (!view.preferencesSettled) return null;
			if (!view.creditVisible) return null;
			const label = view.footTitle === "" ? t("footerLabel") : view.footTitle;
			if (!props.wide) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: "wbp-railButton",
				"aria-label": t("railLabel"),
				title: label,
				onClick: () => {
					props.open();
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Ring, {
					percent: ringPercent(view),
					warn: view.benchedCount > 0,
					size: 18
				})
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: "wbp-foot",
				"aria-label": label,
				title: label,
				onClick: () => {
					props.open();
				},
				onDoubleClick: () => {
					refresh();
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: "wbp-footTop",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "wbp-footName",
						children: t("nav")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "wbp-spacer" })]
				}), view.footProducts.map((product) => {
					const remaining = product.creditsRemaining;
					const capacity = product.creditsCapacity;
					const format = (value) => new Intl.NumberFormat(void 0, { maximumFractionDigits: 1 }).format(value);
					const used = capacity === void 0 || remaining === void 0 ? void 0 : Math.max(0, capacity - remaining);
					const percent = capacity === void 0 || capacity <= 0 || used === void 0 ? 0 : Math.min(100, used / capacity * 100);
					const usageStyle = view.creditStyle === "usage";
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: cx("wbp-footRow", usageStyle && "wbp-footRowUsage"),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "wbp-footHead",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "wbp-footLabel",
								children: usageStyle ? product.name : t("creditRemainingLabel", { product: product.name })
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "wbp-footAmount",
								children: product.state !== "signed-in" ? stateText(product, t) : usageStyle ? used === void 0 || capacity === void 0 ? remaining === void 0 ? t("creditPending") : t("creditRemaining", { remaining: format(remaining) }) : t("creditUsed", {
									used: format(used),
									total: format(capacity)
								}) : remaining === void 0 ? t("creditPending") : format(remaining)
							})]
						}), !usageStyle || product.state !== "signed-in" || capacity === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "wbp-footBar",
							role: "progressbar",
							"aria-label": product.name,
							"aria-valuemin": 0,
							"aria-valuemax": 100,
							"aria-valuenow": Math.round(percent),
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "wbp-footFill",
								style: { width: `${String(percent)}%` }
							})
						})]
					}, product.id);
				})]
			});
		}
		//#endregion
		//#region src/client/provider-card.tsx
		/**
		* The WorkBuddy card inside the harness Models settings page (browser half).
		*
		* Rendered through the `settings.models.provider-card` keyed slot, registered
		* under `entryKey = settingsNs` — the key the Models page dispatches for every
		* row of an adapter family. That row exists because the host half now
		* contributes a `registerConfigurableProviders` directory entry for the
		* variant; without it there would be no row and therefore nowhere for this card
		* to render (see `src/index.ts`).
		*
		* The Models page keeps its own editor, which for this namespace has no fields
		* to offer. This card is the real surface beside it: the pool's state, the
		* accounts and their balances, and the way through to the accounts page. It
		* deliberately does NOT duplicate the whole page — a row in a provider list is
		* a summary, and the full management surface is one click away.
		*
		* Styles ride the settings page's stylesheet (`wbp-` classes), injected once by
		* the client entry, so the card and the page it summarizes cannot drift apart
		* visually.
		*
		* @module dsh-workbuddy-connect/client/provider-card
		*/
		/** How often the card re-reads its product while it is on screen. */
		const REFRESH_INTERVAL_MS = 3e4;
		/**
		* Bind this card's dictionary to the shared account-summary words.
		*
		* The provider card states the same facts as the accounts page, so it reuses
		* the same projection; only the wording comes from this namespace.
		*/
		function summaryCopy(t) {
			return {
				disabled: t("accountStateDisabled"),
				sessionDead: t("accountStateSessionDead"),
				exhausted: t("accountStateExhausted"),
				limited: t("accountStateLimited"),
				expired: t("accountExpired"),
				creditsFailed: t("accountCreditsFailed"),
				creditsPending: t("accountCreditsPending"),
				remainingOf: ({ remaining, total }) => t("accountMetaRemainingOf", {
					remaining,
					total
				}),
				remaining: ({ remaining }) => t("accountMetaRemaining", { remaining }),
				used: ({ used }) => t("accountMetaUsed", { used }),
				requests: ({ count }) => t("accountMetaRequests", { count }),
				inputTokens: ({ value }) => t("accountMetaInputTokens", { value }),
				outputTokens: ({ value }) => t("accountMetaOutputTokens", { value }),
				cache: ({ percent }) => t("accountMetaCache", { percent }),
				resets: ({ when }) => t("accountMetaResets", { when }),
				tokenExpires: ({ when }) => t("accountMetaTokenExpires", { when }),
				wait: ({ value, unit }) => t(unit === "hour" ? "waitHours" : "waitMinutes", { value })
			};
		}
		/**
		* Which variant this occurrence belongs to.
		*
		* The slot hands the card its directory row, so the provider id is the one
		* reliable answer; without a row (an older host that dispatches the slot with
		* no owner props) the card degrades to the first variant rather than refusing
		* to render.
		*/
		function variantFor(owner) {
			const id = owner?.provider?.provider;
			return CARD_VARIANTS.find((variant) => variant.id === id) ?? CARD_VARIANTS[0];
		}
		/**
		* The card body. Reads its own product's status document, which is the same
		* route the accounts page and the dashboard read — one source, so the three
		* surfaces cannot disagree about a balance.
		*/
		function WorkBuddyProviderCard(props) {
			const variant = variantFor(props);
			const { t } = props;
			const [status, setStatus] = (0, react.useState)();
			const [failed, setFailed] = (0, react.useState)(false);
			const [reading, setReading] = (0, react.useState)(false);
			const mounted = (0, react.useRef)(true);
			(0, react.useEffect)(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);
			const read = (0, react.useCallback)(async (signal) => {
				if (signal === void 0) setReading(true);
				try {
					const result = await readWorkBuddyStatus(variant, signal);
					if (!mounted.current || signal?.aborted === true) return;
					if (result.state !== "read") {
						setFailed(true);
						return;
					}
					setStatus(result.status);
					setFailed(false);
				} finally {
					if (signal === void 0 && mounted.current) setReading(false);
				}
			}, [variant.statusPath]);
			(0, react.useEffect)(() => {
				const controller = new AbortController();
				read(controller.signal);
				const tick = window.setInterval(() => {
					read(controller.signal);
				}, REFRESH_INTERVAL_MS);
				return () => {
					window.clearInterval(tick);
					controller.abort();
				};
			}, [read]);
			const accounts = status !== void 0 && "accounts" in status ? status.accounts?.accounts ?? [] : [];
			const signedIn = status !== void 0 && status.status === "signed-in";
			const ready = accounts.filter((account) => account.available).length;
			const benched = accounts.filter((account) => account.cooldown !== void 0 && account.cooldown.untilMs > Date.now()).length;
			const models = signedIn ? status.models?.length ?? 0 : 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "wbp-providerCard",
				children: [
					failed && status === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "wbp-rowError",
						children: t("requestFailed")
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "wbp-tiles",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatTile, {
								label: t("cardAccounts"),
								value: String(accounts.length),
								sub: accounts.length === 0 ? void 0 : t("cardReady", {
									ready,
									total: accounts.length
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatTile, {
								label: t("cardModels"),
								value: String(models)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatTile, {
								label: t("cardBenched"),
								value: String(benched),
								...benched === 0 ? {} : { sub: t("accountStateLimited") }
							})
						]
					}),
					accounts.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "wbp-hint",
						children: t("accountEmpty")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "wbp-accountList",
						children: accounts.map((account) => {
							const copy = summaryCopy(t);
							const state = accountSummaryState(account, Date.now(), copy);
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "wbp-accountRow",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "wbp-accountHead",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusDot, {
											tone: state.tone,
											title: state.text === "" ? t("accountStateReady") : state.text
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "wbp-accountName",
											title: account.name,
											children: account.name
										}),
										state.text === "" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "wbp-usagePlanStatus",
											children: state.text
										})
									]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "wbp-accountMeta",
									children: accountSummaryMeta(account, Date.now(), copy)
								})]
							}, account.id);
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "wbp-inlineActions",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
							label: t("cardRefresh"),
							disabled: reading,
							onClick: () => {
								read();
							}
						})
					})
				]
			});
		}
		/** Notify every subscriber without letting one faulty consumer suppress the rest. */
		function notify(listeners) {
			for (const listener of listeners) try {
				listener();
			} catch (error) {
				console.error("[dsh-workbuddy-connect] panel subscriber failed:", error);
			}
		}
		/**
		* Create the shared panel store.
		*
		* A failed read leaves that variant's previous document in place rather than
		* clearing it: a transient network error must not blank a dashboard the user is
		* looking at, and the next sweep replaces it anyway.
		*/
		function createWorkBuddyPanelStore(options = {}) {
			const variants = options.variants ?? CARD_VARIANTS;
			const doFetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
			const intervalMs = options.intervalMs ?? 6e4;
			const now = options.now ?? (() => Date.now());
			let snapshot = {
				statuses: {},
				loading: false,
				fetchedAt: 0
			};
			const listeners = /* @__PURE__ */ new Set();
			let inFlight;
			let timer;
			const publish = (next) => {
				if (Object.is(next.statuses, snapshot.statuses) && next.loading === snapshot.loading && next.fetchedAt === snapshot.fetchedAt) return;
				snapshot = next;
				notify(listeners);
			};
			const sweep = async () => {
				publish({
					...snapshot,
					loading: true
				});
				const answers = await Promise.all(variants.map(async (variant) => {
					try {
						const response = await doFetch(variant.statusPath, {
							headers: { accept: "application/json" },
							credentials: "same-origin"
						});
						if (!response.ok) return void 0;
						const value = await response.json().catch(() => void 0);
						return isWorkBuddyWebStatus(value) ? [variant.id, value] : void 0;
					} catch {
						return;
					}
				}));
				const statuses = { ...snapshot.statuses };
				for (const answer of answers) if (answer !== void 0) statuses[answer[0]] = answer[1];
				publish({
					statuses,
					loading: false,
					fetchedAt: now()
				});
			};
			return {
				getSnapshot: () => snapshot,
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				refresh() {
					if (inFlight !== void 0) return inFlight;
					inFlight = sweep().finally(() => {
						inFlight = void 0;
					});
					return inFlight;
				},
				start() {
					if (timer !== void 0) return () => {
						if (timer === void 0) return;
						clearInterval(timer);
						timer = void 0;
					};
					this.refresh();
					timer = setInterval(() => {
						this.refresh();
					}, intervalMs);
					timer.unref?.();
					return () => {
						if (timer === void 0) return;
						clearInterval(timer);
						timer = void 0;
					};
				}
			};
		}
		//#endregion
		//#region src/client/ui-styles.ts
		/**
		* Two stylesheets for the WorkBuddy surfaces: the settings page (and the
		* Models-page provider card, which shares its classes) and the plans panel
		* (the sidebar footer card plus the dashboard it opens).
		*
		* Returned as strings rather than injected here so the modules stay free of DOM
		* side effects at import time: `./index.tsx` installs each once, keyed by its
		* own `data-plugin-css` id. The metrics are the harness's own settings pages'
		* — read out of the 0.1.7 bundles so these surfaces sit beside General and
		* Models without looking foreign: a row is 16px of padding over a 0.5px
		* border-l2 hairline, its title 14/22 label-primary, its description 12/18
		* label-tertiary, the control on the right. Inputs are 32px with an 8px radius,
		* a card is a 0.5px border-l4 outline with a 16px radius, a nested panel is a
		* bg-module-platform fill.
		*
		* Two design rules hold throughout, both learned from the reference
		* implementation this is ported from (dsh-commandcode-provider):
		*
		* - **No literal colours.** Every value is a `--dsw-alias-*` token with a
		*   neutral fallback, so the page follows the active theme, light or dark.
		*   Literal colours get this wrong in exactly one mode: `brand-primary`
		*   inverts between them, so a hardcoded white thumb vanishes in dark mode.
		* - **The content column is a fixed 720px稿纸.** The page is a stack of
		*   groups of hairline-separated rows — no card surfaces — which is what makes
		*   it read as a settings page rather than as a dashboard.
		*
		* The `wbp-` prefix is kept (rather than the reference's `cc-`) because these
		* rules are GLOBAL CSS: another plugin's stylesheet with the same prefix would
		* silently restyle these surfaces, and the reference plugin is installed on
		* this machine.
		*
		* @module dsh-workbuddy-connect/client/ui-styles
		*/
		/** Idempotency key for the settings-page stylesheet. */
		const PAGE_CSS_ID = "dsh-workbuddy-connect-page";
		/** Idempotency key for the panel stylesheet. */
		const PANEL_CSS_ID = "dsh-workbuddy-connect-panel";
		/**
		* The settings-page stylesheet: a 720px column of groups, each a heading over
		* hairline-separated rows, plus the fields, toggles, segmented controls,
		* account cards and dialogs the page composes from it.
		*/
		const PAGE_CSS = `
.wbp-section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;display:flex}
.wbp-spacer{flex:1}
/* Groups: a heading over hairline-separated rows, no card surface. */
.wbp-group{flex-direction:column;display:flex;margin-top:28px}
.wbp-groupHead{align-items:center;gap:8px;display:flex;min-height:28px;padding-bottom:4px}
.wbp-groupTitle{margin:0;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}
.wbp-groupDesc{margin:0 0 12px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.wbp-rows>.wbp-groupDesc{margin:0;padding:4px 0 0}
.wbp-rows{flex-direction:column;display:flex}
.wbp-row{align-items:center;gap:8px;display:flex;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.wbp-rows>.wbp-row:last-child{border-bottom:0}
.wbp-rowNested{padding-left:16px}
.wbp-rowFlush{padding:0;border-bottom:0}
.wbp-rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:32px;display:flex}
.wbp-rowTitleLine{align-items:center;gap:8px;display:flex;min-width:0}
.wbp-rowTitle{min-width:0;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}
.wbp-rowDesc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.wbp-rowDesc p{margin:0}
.wbp-rowDesc p+p{margin-top:4px}
.wbp-rowError{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.wbp-rowControl{flex:none;align-items:center;justify-content:flex-end;gap:8px;display:inline-flex;max-width:60%}
/* The platform's link button: a compact capsule with no fill until hovered. */
.wbp-linkButton{box-sizing:border-box;flex:none;align-items:center;display:inline-flex;height:28px;padding:0 10px;border:0;border-radius:14px;background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer}
.wbp-linkButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.wbp-linkButton:disabled{cursor:default;opacity:.4}
.wbp-linkButton:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
/* Tags: the platform Tag's capsule (11/17, weight 500). */
/* A label paired with a value on one baseline (the total-credit line). */
.wbp-factLabel{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.wbp-factValue{color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
/* The stacked field (the Models-page provider card and the account forms):
 * the platform SettingsForm field's metrics. */
.wbp-fieldHead{align-items:center;gap:8px;display:flex}
.wbp-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}
.wbp-input{box-sizing:border-box;height:32px;min-width:0;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font:inherit;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.wbp-input::placeholder{color:var(--dsw-alias-label-dimmed)}
.wbp-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.wbp-input:disabled{opacity:.6;cursor:default}
.wbp-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}
/* An informational outcome (a save that took an older host's route): the same
 * metrics as the error line and the other colour, so it reads as a note. */
.wbp-notice{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-tertiary));margin:0;font-size:12px;line-height:18px}
/* The checkbox, drawn rather than native: color-scheme is set once at BOOT and
 * is not re-applied when the theme is switched in-session, so a native box can
 * paint light chrome on a dark page. The mark rides brand-primary, so it takes
 * the theme's foreground for that fill. */
.wbp-check{box-sizing:border-box;appearance:none;flex-shrink:0;width:16px;height:16px;margin:0;border:1px solid var(--dsw-alias-border-l3);border-radius:4px;background:0 0;position:relative}
.wbp-check:checked{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.wbp-check:checked::after{content:'';position:absolute;top:3px;left:5px;width:3px;height:7px;border:solid var(--dsw-alias-label-primary-foreground,#fff);border-width:0 1.5px 1.5px 0;transform:rotate(45deg)}
.wbp-check:disabled{cursor:default;opacity:.4}
.wbp-checkRow{align-items:center;gap:8px;display:inline-flex;min-width:0}
.wbp-checkRow:hover{cursor:pointer}
.wbp-checkName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The platform Switch: a 36x20 capsule padding its track by 2px, sliding a
 * 16px thumb across the 32px content box. corner-shape:round on both the track
 * and the thumb keeps the capsule from squaring its ends around a round thumb. */
.wbp-toggle{box-sizing:border-box;appearance:none;flex-shrink:0;width:36px;height:20px;margin:0;padding:2px;border:0;border-radius:10px;corner-shape:round;background:var(--dsw-alias-border-l3);cursor:pointer;position:relative}
.wbp-toggle:checked{background:var(--dsw-alias-brand-primary)}
.wbp-toggle::after{content:'';display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-primary-foreground);transition:transform .12s ease}
.wbp-toggle:checked::after{transform:translateX(16px)}
.wbp-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.wbp-toggle:disabled{cursor:default;opacity:.5}
/* The platform SegmentedControl: a translucent track with one raised pill that
 * slides under the picked segment. Segments are equal grid tracks, so the
 * indicator's width and offset follow from the count and index alone — no DOM
 * measurement. */
.wbp-segmented{position:relative;display:inline-grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:2px;padding:4px;border-radius:var(--dsw-radius-md,9px);background:var(--dsw-alias-interactive-bg-hover)}
.wbp-segmentIndicator{position:absolute;top:4px;left:4px;width:calc((100% - 8px - 2px * (var(--wbp-segment-count) - 1)) / var(--wbp-segment-count));height:calc(100% - 8px);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft,0 1px 2px rgba(0,0,0,.12));transform:translateX(calc(var(--wbp-segment-index) * (100% + 2px)));transition:transform .16s ease;pointer-events:none}
.wbp-segment{box-sizing:border-box;position:relative;z-index:1;height:28px;padding:0 16px;border:0;border-radius:var(--dsw-radius-sm,6px);background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;line-height:20px;white-space:nowrap;cursor:pointer;transition:color .12s ease}
.wbp-segment:hover:not(:disabled),.wbp-segment[aria-checked=true]{color:var(--dsw-alias-label-primary)}
.wbp-segment:disabled{cursor:default;opacity:.4}
/* ------------------------------------------------- the model picker menu */
/* The multi-select trigger: the platform's selector capsule (the reference
 * implementation's .cc-selector, same numbers). */
.wbp-modelSelectAnchor{flex-direction:column;align-items:stretch;gap:6px;display:inline-flex;min-width:160px}
.wbp-selector{box-sizing:border-box;align-items:center;gap:12px;display:inline-flex;height:36px;padding:0 14px;border:0;border-radius:18px;corner-shape:round;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;text-align:left;cursor:pointer}
.wbp-selector:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.wbp-selector:disabled{cursor:default;opacity:.4}
.wbp-selector:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
.wbp-selectorText{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wbp-selectorCaret{flex-shrink:0;border-right:1.5px solid var(--dsw-alias-label-tertiary);border-bottom:1.5px solid var(--dsw-alias-label-tertiary);width:6px;height:6px;margin-bottom:3px;transform:rotate(45deg)}
/* The portaled list needs its own floor: the models are long names, and a menu
 * clamped to the trigger's width would ellipsis the part that tells two of them
 * apart. */
.wbp-modelMenu{min-width:240px}
/* The search box sits INSIDE the Menu anchor, so typing in it never trips the
 * Menu's outside-click close. */
.wbp-modelSearch{width:100%}
.wbp-modelSearch::-webkit-search-cancel-button{cursor:pointer}
/* A model the filter excludes: the platform's muted dot, the same mark the
 * reference implementation's account default-state column uses. */
.wbp-modelFiltered{flex-shrink:0;width:6px;height:6px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary))}
/* Three dots from one element: the dot itself plus two box-shadow copies (the
 * reference implementation's .cc-kebab). */
.wbp-kebab{width:3px;height:3px;border-radius:50%;corner-shape:round;background:currentColor;box-shadow:0 -5px 0 currentColor,0 5px 0 currentColor}
/* ------------------------------------------------ account meters (cc port) */
/* ------------------------------------------- the add-account affordance */
/* The Models page's dashed add button, opening a filled panel in its place. */
/* ------------------------------------------------------ staged edit bar (cc port) */
/* The floating save bar, pinned to the bottom of the page's scrollport and slid
 * out of view when there is nothing to save. Ported from the reference
 * implementation's .cc-saveBar: a 44px capsule, 22px radius, concentric 36px
 * buttons, and a leading tone dot. */
.wbp-saveBarDock{position:sticky;bottom:0;z-index:20;height:0;pointer-events:none}
.wbp-saveBar{--wbp-saveBar-tone:var(--dsw-alias-state-warn-primary,#d97706);position:absolute;left:50%;bottom:20px;box-sizing:border-box;width:max-content;max-width:calc(100% - 24px);align-items:center;gap:10px;display:flex;height:44px;padding:4px 4px 4px 16px;border:0;border-radius:22px;corner-shape:round;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent,0 12px 32px -8px rgba(0,0,0,.24),0 2px 8px rgba(0,0,0,.08));opacity:0;visibility:hidden;transform:translate(-50%,12px);transition:opacity .16s ease,transform .16s ease,visibility 0s linear .16s}
.wbp-saveBarShown{opacity:1;visibility:visible;transform:translate(-50%,0);pointer-events:auto;transition:opacity .2s ease,transform .24s cubic-bezier(.2,.9,.3,1.1),visibility 0s}
.wbp-saveBarError{--wbp-saveBar-tone:var(--dsw-alias-state-error-primary)}
.wbp-saveBarSuccess{--wbp-saveBar-tone:var(--dsw-alias-state-success-primary,#16a34a);padding-right:18px}
.wbp-saveBarIcon{flex-shrink:0;align-items:center;justify-content:center;display:inline-flex;width:16px;height:16px;color:var(--wbp-saveBar-tone)}
.wbp-saveBarPulse{width:8px;height:8px;border-radius:50%;corner-shape:round;background:var(--wbp-saveBar-tone)}
.wbp-saveBarText{min-width:0;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.wbp-saveBarError .wbp-saveBarText{color:var(--dsw-alias-state-error-primary)}
.wbp-saveBarActions{flex-shrink:0;align-items:center;gap:4px;display:flex;margin-left:8px}
.wbp-saveBarButton{box-sizing:border-box;height:36px;padding:0 16px;border:0;border-radius:18px;corner-shape:round;font:inherit;font-size:14px;line-height:22px;white-space:nowrap;cursor:pointer}
.wbp-saveBarButton:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
.wbp-saveBarButton:disabled{cursor:default;opacity:.4}
.wbp-saveBarGhost{background:0 0;color:var(--dsw-alias-label-primary)}
.wbp-saveBarGhost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.wbp-saveBarPrimary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));color:var(--dsw-alias-label-primary-foreground,#fff)}
.wbp-saveBarPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary)))}
/* ------------------------------------------------------------- accounts */
/* One card per PRODUCT, every account of that product as a row inside it.
 * The card is the platform's outlined surface (0.5px border-l4, 16px radius),
 * because it groups rows rather than being a row itself; the rows inside carry
 * no chrome at all, only a hairline between them. */
.wbp-productCards{flex-direction:column;gap:12px;display:flex}
.wbp-productCard{box-sizing:border-box;flex-direction:column;display:flex;padding:12px 14px 4px;border:.5px solid var(--dsw-alias-border-l4);border-radius:16px;min-width:0}
.wbp-productHead{align-items:center;gap:8px;display:flex;min-width:0;padding-bottom:8px}
.wbp-productName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}
.wbp-productCount{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.wbp-productTotal{flex:none;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;font-variant-numeric:tabular-nums;white-space:nowrap}
.wbp-productDetail{margin:0 0 8px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.wbp-accountList{flex-direction:column;display:flex;min-width:0}
/* One account: a name line and ONE grey line under it. No disclosure, no
 * per-account card — the pool is one subject and its rows are comparable only
 * when they share a frame. The hairline separates rows, and the last row drops
 * it so the card's own border is the only line at the bottom. */
.wbp-accountRow{flex-direction:column;gap:2px;display:flex;min-width:0;padding:10px 2px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.wbp-accountList>.wbp-accountRow:last-child{border-bottom:0}
/* The account the pool is actually serving from: the reference
 * implementation's own active-row mark, kept as a left accent rather than a
 * border so it does not shift the row's text by a pixel when it flips. */
.wbp-accountRowActive{padding-left:8px;box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}
.wbp-accountHead{align-items:center;gap:8px;display:flex;min-width:0;min-height:22px}
.wbp-accountName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}
/* The grey meta line: every figure the row states, separated by a middot. It
 * wraps rather than truncates — a figure the reader cannot see is worse than a
 * second line — and its numbers are tabular so rows line up down the column. */
.wbp-accountMeta{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.wbp-usagePlanStatus{flex:none;margin:0;white-space:nowrap;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.wbp-iconButton{flex-shrink:0;align-items:center;justify-content:center;display:inline-flex;width:28px;height:28px;padding:0;background:0 0;border:0;border-radius:6px;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.wbp-iconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.wbp-iconButton:disabled{cursor:default;opacity:.4}
.wbp-iconButton:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
.wbp-inlineForm,.wbp-confirmBar{flex-direction:column;gap:8px;display:flex}
.wbp-inlineActions{align-items:center;gap:8px;display:flex;flex-wrap:wrap}
.wbp-confirmBar{border:.5px solid var(--dsw-alias-state-error-primary);border-radius:12px;padding:12px 14px}
.wbp-confirmText{color:var(--dsw-alias-label-primary);margin:0;font-size:14px;line-height:22px}
/* Adding an account: the Models page's dashed add button, opening a filled
 * panel in its place. */
/* Account report: stat tiles are filled panels, like the platform's editors. */
/* The per-product total tiles sit under the account cards, so they need the
 * same air the add button gets — flush against the last card they read as part
 * of it. The reference implementation has no equivalent row, so this spacing is
 * ours to set. */
.wbp-usageStat{min-width:0;flex-direction:column;gap:2px;display:flex;padding:10px 12px;border-radius:12px;background:var(--dsw-alias-bg-module-platform)}
.wbp-usageStatLabel{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.wbp-usageStatValue{color:var(--dsw-alias-label-primary);font-size:16px;font-weight:500;line-height:24px;font-variant-numeric:tabular-nums}
.wbp-usageStatSub{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* Tabs across the top of the page: one per product. */
/* --------------------------------------------------------------- models */
.wbp-modelRow{align-items:center;gap:8px;display:flex;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
/* The row's left half: the mark, the name, its promotions and its rate. Grows to take the space the fixed control column leaves. */
.wbp-modelMain{align-items:center;gap:8px;display:flex;flex:1;min-width:0}
.wbp-modelName{min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The row's right-hand column, as a fixed grid so the rows line up top to
 * bottom: one column per slot (probe result, Detect button, context figure),
 * each sized to its widest occupancy. Flow layout could not hold a column — a
 * row without a Detect button would pull its context figure left, and the
 * figures would read as ragged down the page even though every row is
 * individually correct.
 *
 * The two fixed tracks are the widths of the button and of the context figure
 * at their widest real content, so a row can be missing either without shifting
 * the other. The first track is auto so the result badge takes what it needs;
 * justify-items:end keeps every cell flush right, which is what makes the
 * column's edge straight. */
.wbp-modelControl{flex:none;align-items:center;display:grid;grid-template-columns:auto 76px minmax(120px,auto);gap:8px;justify-items:end}
.wbp-modelProbeResult{display:inline-flex;justify-content:flex-end;min-width:0}
.wbp-modelProbeAction{display:inline-flex;justify-content:flex-end}
.wbp-modelContext{display:inline-flex;justify-content:flex-end;align-items:center;text-align:right;white-space:nowrap}
/* --------------------------------------------------------------- dialogs */
/* The overlay portals to document.body (see WorkBuddySettingsPage), so its
   z-index is compared in the ROOT stacking context — against the host's own
   chrome, not just this page. The host stacks its shell and chat surfaces up
   to z-index 1100 and reserves layers beyond that; the original 60 sat behind
   the Settings surface the dialog was opened from, so the click meant to
   dismiss the dialog landed on Settings instead — and closing Settings
   unmounted the dialog with it. Pinned near the top of the 32-bit range: a
   modal this plugin opens must never interleave with host chrome. */
.wbp-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-mask,rgba(0,0,0,.45))}
.wbp-dialog{box-sizing:border-box;width:100%;max-width:380px;display:flex;flex-direction:column;gap:14px;padding:20px;border-radius:16px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent,0 12px 32px -8px rgba(0,0,0,.24))}
.wbp-dialogTitle{margin:0;color:var(--dsw-alias-label-primary);font-size:16px;line-height:24px;font-weight:500;text-align:center}
.wbp-dialogBody{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.wbp-dialogActions{display:flex;justify-content:flex-end;gap:8px}
.wbp-qrFrame{display:flex;align-items:center;justify-content:center;padding:12px;border-radius:12px;background:#fff}
.wbp-tokenArea{box-sizing:border-box;width:100%;min-height:96px;padding:10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;resize:vertical}
/* The address of a page no strategy could open: a copy target, so it stays
 * selectable and reads in the same field style as the other inputs. */
.wbp-linkFallback{display:flex;flex-direction:column;gap:8px}
.wbp-linkFallback .wbp-input{font-size:12px}
.wbp-tokenArea:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
@media (prefers-reduced-motion:reduce){.wbp-toggle::after,.wbp-segmentIndicator,.wbp-segment{transition:none}}
`;
		/** The panel stylesheet. */
		const PANEL_CSS = `
/* ------------------------------------------------- sidebar footer card */
/* The shell's foot area renders this list ABOVE the Settings seat, so the card
   is the sidebar's bottom-most content. The shell supplies no chrome: the entry
   is the button. It is deliberately quiet — a surface that sits beside Settings
   should read as part of the column, not as a call to action — with one hover
   step and a hairline border.

   The shell's container is a flex ROW whose occupants each declare a full-width
   line, so as a row it would overflow the column: this card cannot shrink and a
   sibling sized 100% would absorb the whole overflow. Both were written for a
   full-width line, which is what a column gives them. Matched by the CSS-module
   class STEM — never a hashed name — so a renamed shell degrades to its own row
   rather than breaking, and anchored under "footArea" rather than the bare
   "footerActions" stem because that stem is NOT the shell's alone:
   dsh-client-ui-user-questions renders the ask-user-question dialog's button
   row with it, and the unanchored rule stacked that dialog's side-by-side
   buttons on every page. The descendant combinator (rather than a child one)
   deliberately survives a wrapper element appearing between the two. */
[class*="_footArea"] [class*="_footerActions"]{flex-direction:column}
.wbp-foot{box-sizing:border-box;flex:0 0 auto;width:100%;min-width:0;font:inherit;color:var(--dsw-alias-label-secondary);text-align:left;cursor:pointer;background:0 0;border:1px solid transparent;border-radius:10px;flex-direction:column;gap:6px;margin:0 0 4px;padding:8px;display:flex}
.wbp-foot:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2)}
.wbp-foot:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.wbp-footTop{align-items:center;gap:8px;min-width:0;display:flex}
.wbp-footName{white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;font-size:13px;font-weight:500;line-height:20px}
/* ONE line per product: the label names the figure, the figure sits flush right.
 * nowrap on both halves is load-bearing — the label carries the product name and
 * "剩余额度", and a wrap would put the number on a line of its own, which is
 * exactly the stacked layout this replaced. */
.wbp-footRow{align-items:baseline;gap:8px;min-width:0;display:flex}
/* The "used / total + bar" style stacks its head line over a full-width bar; the
 * default style is the single line above. Two shapes rather than two skins of one
 * markup, because the bar must span the card, not the space left beside a figure. */
.wbp-footRowUsage{flex-direction:column;gap:4px;align-items:stretch}
.wbp-footHead{align-items:baseline;gap:8px;min-width:0;display:flex}
.wbp-footLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.wbp-footAmount{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;white-space:nowrap}
.wbp-footBar{display:block;width:100%;background:var(--dsw-alias-bg-layer-2);border-radius:999px;height:5px;overflow:hidden}
.wbp-footFill{display:block;background:var(--dsw-alias-brand-primary);border-radius:999px;height:100%;transition:width .3s ease}
/* ------------------------------------------------------- composer badge */
/* The credit figure in the composer dock, to the RIGHT of the harness's own
 * context readout.
 *
 * Two CSS facts make that placement work, and both are needed:
 *
 * - The dock renders the slot's entries FIRST and appends its own context meter
 *   after them, and the slot outlet uses display:contents, so this element is a
 *   direct flex item of the dock. DOM order alone would therefore put the badge
 *   LEFT of the meter; the flex order below is what moves it after.
 * - The dock centres its items, so being last is not the same as being at the
 *   edge. margin-left:auto absorbs the free space on the badge's left only, which
 *   pins it to the row's right end with the meter beside it.
 *
 * The trigger copies the context meter's (.JObwrW_trigger) metrics: same radius
 * token, same secondary text size, same 1px/8px padding and 6px gap, and the same
 * hover/[aria-expanded] fill — the two sit side by side in one row, so any drift
 * between them reads as one of the two being broken. */
.wbp-creditBadgeRoot{flex:none;display:inline-flex;align-items:center;order:1;margin-left:auto;position:relative}
.wbp-creditBadge{border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:var(--dsh-content-font-size-secondary,13px);font-variant-numeric:tabular-nums;line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));white-space:nowrap;cursor:pointer;background:0 0;border:none;flex:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}
.wbp-creditBadge:hover,.wbp-creditBadge[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.wbp-creditBadge:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.wbp-creditBadgeName{color:inherit}
.wbp-creditBadgeValue{color:var(--dsw-alias-label-secondary)}
.wbp-creditBadge[aria-expanded=true] .wbp-creditBadgeValue{color:var(--dsw-alias-label-primary)}
/* The expanded panel: the context popover's own material (.JObwrW_panel) —
 * the menu surface plus its backdrop filter, the prominent elevation token, the
 * same 12px/-lg radius, the same min(264px, …) width, and the same 12px padding
 * and 12px type. Fixed-positioned from the trigger (and portalled) so it survives
 * scrolling and the composer's own overflow. */
.wbp-badgePanel{position:fixed;z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);width:min(264px,100vw - 24px);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:12px;font-size:12px;line-height:20px}
/* One product's block, with the pool's own line above its accounts. Separated by
 * a margin rather than a rule: the context popover's two sections are set apart
 * the same way, and a hairline here would draw a card the row above does not. */
.wbp-badgeGroup+.wbp-badgeGroup{margin-top:12px}
.wbp-badgeGroupHead{display:flex;align-items:center;gap:6px}
.wbp-badgeGroupName{color:var(--dsw-alias-label-tertiary)}
.wbp-badgeGroupTotal{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin-left:auto;font-weight:500}
.wbp-badgeBar{corner-shape:round;background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;height:4px;margin:10px 0 12px;display:flex;overflow:hidden}
.wbp-badgeBarFill{background:var(--dsw-alias-brand-primary);border-radius:1px;min-width:2px;height:100%;display:block}
.wbp-badgeRows{margin:6px 0 0}
.wbp-badgeRow{justify-content:space-between;align-items:center;gap:12px;padding:2px 0;display:flex}
.wbp-badgeRow dt{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.wbp-badgeRow dd{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin:0;white-space:nowrap}
/* The expanded panel: the context popover's own material (.JObwrW_panel) —
 * the menu surface plus its backdrop filter, the prominent elevation token, the
 * same 12px/-lg radius, the same min(264px, …) width, and the same 12px padding
 * and 12px type. Fixed-positioned from the trigger (and portalled) so it survives
 * scrolling and the composer's own overflow. */
/* One product's block, with the pool's own line above its accounts. Separated by
 * a margin rather than a rule: the context popover's two sections are set apart
 * the same way, and a hairline here would draw a card the row above does not. */
/* -------------------------------------------------------- the rail icon */
.wbp-railButton{box-sizing:border-box;width:36px;height:36px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:1px solid transparent;border-radius:8px;flex:none;justify-content:center;align-items:center;margin:0 0 4px;padding:0;display:inline-flex}
.wbp-railButton:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.wbp-railButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
/* The quota ring: one glyph serves the rail button, the card's head and the
   dashboard header. Circumference 2πr = 45.55 at r = 7.25. */
.wbp-glyph{flex:none;justify-content:center;align-items:center;display:inline-flex;color:var(--dsw-alias-brand-primary)}
/* ----------------------------------------------------------- dashboard */
.wbp-main{background:var(--dsw-alias-bg-layer-1);width:100%;height:100%;overflow:auto;display:block}
.wbp-mainInner{max-width:760px;margin:0 auto;padding:24px 20px 40px;flex-direction:column;gap:14px;display:flex;color:var(--dsw-alias-label-primary)}
.wbp-header{align-items:center;gap:10px;display:flex;flex-wrap:wrap}
.wbp-headerText{flex-direction:column;gap:2px;display:flex;min-width:0}
.wbp-titleLg{margin:0;font-size:18px;font-weight:600;line-height:1.4}
.wbp-subtitle{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.wbp-notice{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:12px 14px;flex-direction:column;gap:4px;display:flex}
.wbp-noticeError{border-color:var(--dsw-alias-state-error-primary)}
.wbp-noticeTitle{margin:0;font-size:13px;font-weight:600;line-height:1.5}
.wbp-noticeError .wbp-noticeTitle{color:var(--dsw-alias-state-error-primary)}
.wbp-noticeHint{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55}
/* One product's card: the account head, its quota windows, its totals. */
.wbp-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:14px;padding:16px 18px;flex-direction:column;gap:16px;display:flex}
.wbp-cardHead{align-items:center;gap:10px;display:flex;flex-wrap:wrap}
.wbp-avatar{flex:none;width:28px;height:28px;color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-module-platform);border-radius:50%;justify-content:center;align-items:center;font-size:12px;font-weight:600;line-height:1;display:inline-flex}
.wbp-cardIdentity{flex-direction:column;gap:1px;min-width:0;display:flex}
.wbp-cardTitle{font-size:13px;font-weight:600;line-height:1.4}
.wbp-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}
/* One account's bench: a labelled bar over its remaining wait. */
@media (prefers-reduced-motion:reduce){.wbp-barFill,.wbp-footFill{transition:none}}
`;
		//#endregion
		//#region src/client/locales.ts
		const en = {
			title: "DSH WorkBuddy Connect Functy",
			intro: "Use the models in the WorkBuddy desktop app directly in DSH — zero configuration, ready out of the box.",
			titleAI: "DSH WorkBuddy AI Connect Functy",
			introAI: "Use the models in the WorkBuddy AI international desktop app directly in DSH — zero configuration, ready out of the box.",
			collapse: "Collapse",
			loading: "Loading account…",
			signedOut: "Not signed in",
			signedOutHint: "Sign in once in the WorkBuddy desktop app; this plugin follows that sign-in automatically.",
			signedOutHintAI: "Sign in once in the WorkBuddy AI desktop app; this plugin follows that sign-in automatically.",
			accessTokenExpires: "Access token expires {time} (refresh is automatic)",
			creditsTotal: "Total: {total}",
			creditsError: "Credit unavailable: {message}",
			refresh: "Refresh",
			refreshing: "Refreshing…",
			refreshModels: "Refresh model list",
			catalogError: "Last update failed: {message}",
			requestFailed: "Request failed",
			statusResponseInvalid: "WorkBuddy returned an unreadable status reply",
			accountHeading: "Account",
			contextHeading: "Context window",
			useMaximumContextWindow: "Use the largest declared context window",
			freeModel: "Free",
			rate: "{rate} credits per message",
			rateUnknown: "Price unavailable — refresh to update",
			probeLabel: "Reasoning levels",
			probeTooltipIdle: "Detect the reasoning levels {model} accepts",
			probeTooltipVerified: "Accepted levels: {levels} · click to detect again",
			probeTooltipNotValidating: "This model does not check the effort parameter",
			probeTooltipRetry: "Detection did not complete · click to retry",
			probeBubbleBody: "Send test requests to confirm the available reasoning levels. May consume a small amount of credit.",
			probeConfirmAction: "Confirm",
			probeNoteVerified: "Detected: {levels}",
			probeNoteNotValidating: "This model does not check the effort parameter",
			probeNoteUnknown: "Detection did not complete",
			probeNoteDismiss: "Got it",
			probeStart: "Detect",
			probeRedetect: "Detect again",
			probeRunning: "Detecting {model}…",
			probeConfirmBody: "Send test requests to {model} to confirm its available reasoning levels. May consume a small amount of credit.",
			cancel: "Cancel",
			probeResultNotValidating: "This model does not check the effort parameter",
			probeResultUnknown: "Detection did not complete",
			accountAdd: "Add account",
			accountAddTitle: "Add an account",
			accountAddBody: "Open the mobile app, sign in, and scan this code. The account is added to the plugin only — it does not change the desktop app's sign-in.",
			accountAddWaiting: "Waiting for the scan… ({seconds}s left)",
			accountChecking: "Checking…",
			accountQrExpired: "This code expired. Close the dialog and start again.",
			accountQrInvalid: "This sign-in is no longer valid. Start again.",
			accountEmpty: "No accounts yet. Sign in to the desktop app, or add one by QR.",
			accountEmptyHint: "Sign in once — the desktop app's session is picked up automatically — or add an account below.",
			navWorkBuddy: "DSH-WorkBuddy",
			accountAddCn: "Add WorkBuddy account",
			accountAddPickHint: "Which product is this account for?",
			accountAddAi: "Add WorkBuddy AI account",
			accountLoginQr: "Scan to sign in",
			accountLoginWeb: "Sign in on the web",
			accountLoginDesktop: "Desktop sign-in",
			accountLoginToken: "Sign-in token",
			accountDesktopBody: "Reads the sign-in the WorkBuddy desktop app already holds (WorkBuddy AI for the international product). Use it when the app is signed in but the account is missing from this list — for example after removing it.",
			accountActionLogin: "Add account",
			accountTokenBody: "Paste the sign-in token from the WorkBuddy web console. It is stored on this machine only, and it cannot renew itself — when it expires you paste a new one.",
			accountTokenPlaceholder: "Paste the token here (it starts with eyJ…)",
			accountSubmit: "Add",
			accountOpenLink: "Open sign-in page",
			accountOpenLinkFailed: "The page could not be opened automatically. Copy this address into your browser:",
			accountWebBody: "Sign in on the page that just opened in your browser; the account is added here automatically as soon as it is done.",
			accountWebWaiting: "Waiting for the sign-in to finish… ({seconds}s left)",
			accountExpired: "Sign-in expired",
			modelsHeading: "Models",
			modelsRefresh: "Refresh list",
			modelsSwitchLabel: "Which model list",
			modelsSwitchTitle: "{product} model list · {count} models",
			modelsCount: "{count} models",
			contextLabel: "Context length",
			contextSwitchTitle: "Run this model at {size}",
			modelsEmpty: "No models yet. Refresh the list, or check the account above.",
			modelsSourceLive: "Updated {time}",
			modelsSourceSaved: "Saved list from {time}",
			modelsSourceFallback: "Built-in list",
			accountRotateHint: "Requests rotate between these accounts; one that answers \"too many requests\" is set aside for a while and tried again later.",
			accountTest: "Test",
			accountEnable: "Enable",
			accountDisable: "Disable",
			accountRename: "Rename",
			accountRemove: "Remove",
			accountRemoveConfirm: "Remove {name}? Its stored sign-in is deleted and cannot be recovered without scanning again.",
			accountActions: "Account actions",
			accountRenamePlaceholder: "Account name",
			accountApply: "Apply",
			accountRemoveAction: "Remove account",
			sidebarStyleHeading: "Sidebar",
			sidebarStyleLabel: "Sidebar credit line",
			sidebarStyleHint: "How the sidebar card states each product's credit.",
			sidebarStyleRemaining: "Remaining only",
			sidebarStyleUsage: "Used / total + bar",
			sidebarSettingUnsupported: "This DSH host does not accept the setting. Restart DSH Desktop and try again.",
			sidebarVisibleLabel: "Sidebar credit card",
			sidebarVisibleHint: "Shows both products' balances at the bottom of the sidebar. Off: no card is drawn there, and the dashboard is opened from the sidebar alone.",
			composerVisibleLabel: "Composer credit badge",
			composerVisibleHint: "Shows the selected product's balance at the right of the composer row, beside the context readout. Click it to list every account's credit.",
			probeControlVisibleLabel: "Composer detection control",
			probeControlVisibleHint: "Shows the reasoning-level detection control beside the model selector. Off: detection stays available from this page's model list.",
			accountRefreshAll: "Refresh accounts",
			accountRefreshAllHint: "Re-reads every signed-in account's balance and state, across both products.",
			accountCredits: "Credits {total}",
			accountCreditsPending: "Credits —",
			/** The grey line under an account's name, piece by piece. */
			accountCreditsFailed: "Balance unavailable",
			accountMetaRemaining: "{remaining} left",
			accountMetaRemainingOf: "{remaining} / {total} left",
			accountMetaUsed: "{used} used",
			accountMetaRequests: "{count} requests",
			accountMetaInputTokens: "in {value}",
			accountMetaOutputTokens: "out {value}",
			accountMetaCache: "cache {percent}",
			accountMetaResets: "resets in {when}",
			accountMetaTokenExpires: "token expires in {when}",
			accountStateDisabled: "Off",
			accountStateLimited: "rate limited",
			accountStateExhausted: "out of quota",
			accountStateSessionDead: "sign-in expired",
			accountStateReady: "Ready",
			waitMinutes: "{value} min",
			waitHours: "{value} h",
			accountTestFailed: "Test failed",
			cardAccounts: "Accounts",
			cardModels: "Models",
			cardBenched: "Set aside",
			cardReady: "{ready} of {total} ready",
			cardRefresh: "Refresh",
			filterModelsLabel: "Show only selected models",
			filterModelsHint: "Turn this on to choose which models appear in the model picker. Off shows the whole list.",
			filterModelsIdle: "Tick the models to keep, then turn the switch on. While the switch is off every model stays visible.",
			filterModelsUnsupported: "The running DSH host does not support this filter yet. Restart DSH Desktop and try again.",
			filterModelsFallback: "Saved — this DSH session is running a pre-update copy of the plugin's host half, so the same filter was stored as per-model visibility. Restart DSH Desktop once and it will be stored as a filter list.",
			filterModelsCount: "{ticked} of {total} shown",
			filterModelsExcludedHint: "Hidden from the model picker by the filter above",
			filterModelsClear: "Show all",
			modelPick: "Choose models",
			modelPickCount: "{count} models selected",
			modelSearchPlaceholder: "Search models",
			modelSearchEmpty: "No model matches that search",
			modelStale: "no longer offered",
			saveBarUnsaved: "Unsaved changes",
			saveBarSave: "Save",
			saveBarSaving: "Saving…",
			saveBarDiscard: "Discard",
			saveBarSaved: "Saved",
			checkinHeading: "Daily check-in",
			checkinHint: "The upstream grants daily credit for checking in. Off by default: the plugin never spends a request against your account unless you ask it to.",
			checkinAutoLabel: "Check in automatically",
			checkinAutoHint: "Once a day, for every account that can serve. A check-in never benches an account or changes its sign-in.",
			checkinRunNow: "Check in now",
			checkinRowNever: "not checked in yet",
			checkinRowDay: "checked in {day}",
			checkinRowFailed: "last attempt failed: {reason}",
			checkinRowSkipped: "skipped: {reason}"
		};
		const zh = {
			title: "DSH WorkBuddy Connect Functy",
			intro: "在 DSH 中直接使用 WorkBuddy 桌面 App 包含的模型，开箱即用，无需额外配置。",
			titleAI: "DSH WorkBuddy AI Connect Functy",
			introAI: "在 DSH 中直接使用 WorkBuddy AI 国际版桌面 App 包含的模型，开箱即用，无需额外配置。",
			collapse: "收起",
			loading: "正在读取账号…",
			signedOut: "未登录",
			signedOutHint: "在 WorkBuddy 桌面 App 里登录一次即可，插件会自动跟随当前登录的账号。",
			signedOutHintAI: "在 WorkBuddy AI 国际版桌面 App 里登录一次即可，插件会自动跟随当前登录的账号。",
			accessTokenExpires: "访问令牌 {time} 过期（自动续期）",
			creditsTotal: "合计：{total}",
			creditsError: "积分查询失败：{message}",
			refresh: "刷新",
			refreshing: "正在刷新…",
			refreshModels: "刷新模型列表",
			catalogError: "上次更新失败：{message}",
			requestFailed: "请求失败",
			statusResponseInvalid: "WorkBuddy 返回的状态数据无法识别",
			accountHeading: "账号",
			contextHeading: "上下文窗口",
			useMaximumContextWindow: "使用上游声明的最大上下文窗口",
			freeModel: "免费",
			rate: "{rate} 积分/次",
			rateUnknown: "价格未知 — 刷新后更新",
			probeLabel: "推理等级",
			probeTooltipIdle: "检测 {model} 可用的推理档位",
			probeTooltipVerified: "已接受：{levels} · 点击可重新检测",
			probeTooltipNotValidating: "该模型不校验该参数",
			probeTooltipRetry: "检测未完成 · 点击重试",
			probeBubbleBody: "发送探测请求以确认可用推理档位。可能消耗少量积分。",
			probeConfirmAction: "确认检测",
			probeNoteVerified: "已检测：{levels}",
			probeNoteNotValidating: "该模型不校验该参数",
			probeNoteUnknown: "检测未完成",
			probeNoteDismiss: "知道了",
			probeStart: "开始检测",
			probeRedetect: "重新检测",
			probeRunning: "正在检测 {model}…",
			probeConfirmBody: "向 {model} 发送探测请求，以确认可用推理档位。可能消耗少量积分。",
			cancel: "取消",
			probeResultNotValidating: "该模型不校验该参数",
			probeResultUnknown: "检测未完成",
			accountAdd: "添加账号",
			accountAddTitle: "添加账号",
			accountAddBody: "打开手机 App 登录后扫描此二维码。账号只加入本插件，不会改变桌面 App 的登录状态。",
			accountAddWaiting: "等待扫码…（剩余 {seconds} 秒）",
			accountChecking: "检查中…",
			accountQrExpired: "二维码已过期，关闭后重新发起。",
			accountQrInvalid: "该登录已失效，请重新发起。",
			accountEmpty: "还没有账号。可在桌面 App 登录，或在此扫码添加。",
			accountEmptyHint: "先登录一次即可：桌面 App 的登录态会被自动识别，也可以在下面手动添加账号。",
			navWorkBuddy: "DSH-WorkBuddy",
			accountAddCn: "添加 WorkBuddy 账号",
			accountAddPickHint: "这个账号属于哪一版？",
			accountAddAi: "添加 WorkBuddy AI 账号",
			accountLoginQr: "扫码登录",
			accountLoginWeb: "网页登录",
			accountLoginDesktop: "桌面端凭证",
			accountLoginToken: "Cookie 登录",
			accountDesktopBody: "直接读取已登录的 WorkBuddy 桌面 App 保存的凭证（国际版读 WorkBuddy AI 的）。适用于桌面 App 已登录、但这里列表里没有该账号的情况——比如刚把它删掉之后。",
			accountActionLogin: "添加账号",
			accountTokenBody: "粘贴 WorkBuddy 网页控制台里的登录令牌。它只保存在本机，且无法自动续期 —— 过期后重新粘贴一份即可。",
			accountTokenPlaceholder: "在此粘贴令牌（以 eyJ 开头）",
			accountSubmit: "添加",
			accountOpenLink: "打开登录页面",
			accountOpenLinkFailed: "没能自动打开页面。请把下面的地址复制到浏览器里打开：",
			accountWebBody: "在刚弹出的浏览器页面上完成登录即可，登录完成后账号会自动加入。",
			accountWebWaiting: "等待登录完成…（剩余 {seconds} 秒）",
			accountExpired: "登录已过期",
			modelsHeading: "模型列表",
			modelsRefresh: "刷新列表",
			modelsSwitchLabel: "模型列表切换",
			modelsSwitchTitle: "{product} 的模型列表 · {count} 个模型",
			modelsCount: "{count} 个模型",
			contextLabel: "上下文长度",
			contextSwitchTitle: "以 {size} 运行该模型",
			modelsEmpty: "暂无模型。可刷新列表，或检查上方账号。",
			modelsSourceLive: "更新于 {time}",
			modelsSourceSaved: "已保存的列表，更新于 {time}",
			modelsSourceFallback: "内置列表",
			accountRotateHint: "请求会在这些账号之间轮换；被上游限流的账号会暂时搁置，稍后自动重试。",
			accountTest: "测试",
			accountEnable: "启用",
			accountDisable: "停用",
			accountRename: "重命名",
			accountRemove: "删除",
			accountRemoveConfirm: "确定删除 {name}？其保存的登录凭证会被清除，除非重新扫码否则无法恢复。",
			accountActions: "账号操作",
			accountRenamePlaceholder: "账号名称",
			accountApply: "确定",
			accountRemoveAction: "删除账号",
			sidebarStyleHeading: "侧边栏",
			sidebarStyleLabel: "侧边栏额度显示",
			sidebarStyleHint: "侧边栏卡片怎么显示每一版的额度。",
			sidebarStyleRemaining: "仅剩余额度",
			sidebarStyleUsage: "已用 / 上限 + 进度条",
			sidebarSettingUnsupported: "当前 DSH 宿主不接受这个设置，重启 DSH Desktop 后再试。",
			sidebarVisibleLabel: "侧边栏额度卡片",
			sidebarVisibleHint: "在侧栏底部显示两版的余额。关掉后侧栏不再画这张卡片，仪表盘只从侧栏卡片进入。",
			composerVisibleLabel: "输入框额度徽标",
			composerVisibleHint: "在输入框那一行最右侧（上下文占用右边）显示当前模型所属产品的余额，点击可展开各账号额度。",
			probeControlVisibleLabel: "输入框检测按钮",
			probeControlVisibleHint: "在模型选择器旁显示思考强度检测按钮。关掉后仍可在本页模型列表里检测。",
			accountRefreshAll: "刷新账号",
			accountRefreshAllHint: "重新读取两版所有已登录账号的余额与状态。",
			accountCredits: "积分 {total}",
			accountCreditsPending: "积分 —",
			accountCreditsFailed: "余额读取失败",
			accountMetaRemaining: "剩余 {remaining}",
			accountMetaRemainingOf: "剩余 {remaining} / {total}",
			accountMetaUsed: "已用 {used}",
			accountMetaRequests: "{count} 次请求",
			accountMetaInputTokens: "输入 {value}",
			accountMetaOutputTokens: "输出 {value}",
			accountMetaCache: "缓存 {percent}",
			accountMetaResets: "{when}后恢复",
			accountMetaTokenExpires: "{when}后令牌过期",
			accountStateDisabled: "已停用",
			accountStateLimited: "限流中",
			accountStateExhausted: "额度耗尽",
			accountStateSessionDead: "登录失效",
			accountStateReady: "可用",
			waitMinutes: "{value} 分钟",
			waitHours: "{value} 小时",
			accountTestFailed: "测试失败",
			cardAccounts: "账号",
			cardModels: "模型",
			cardBenched: "搁置中",
			cardReady: "{total} 个中 {ready} 个可用",
			cardRefresh: "刷新",
			filterModelsLabel: "只显示勾选的模型",
			filterModelsHint: "开启后，只有勾选的模型会出现在模型选择列表里；关闭则显示全部。",
			filterModelsIdle: "先勾选要保留的模型，再打开开关。开关关闭时所有模型都会显示。",
			filterModelsUnsupported: "当前运行的 DSH 宿主还不支持这个过滤功能，重启 DSH Desktop 后再试。",
			filterModelsFallback: "已保存 —— 本次 DSH 会话运行的是插件宿主半边的旧副本，所以同一个筛选被存成了「逐模型隐藏」。重启一次 DSH Desktop，就会按筛选列表存。",
			filterModelsCount: "已选 {ticked} / {total}",
			filterModelsExcludedHint: "被上方筛选排除，不会出现在模型选择器里",
			filterModelsClear: "全部显示",
			modelPick: "选择模型",
			modelPickCount: "已选 {count} 个模型",
			modelSearchPlaceholder: "搜索模型",
			modelSearchEmpty: "没有匹配的模型",
			modelStale: "已下线",
			saveBarUnsaved: "有未保存的修改",
			saveBarSave: "保存",
			saveBarSaving: "保存中…",
			saveBarDiscard: "放弃",
			saveBarSaved: "已保存",
			checkinHeading: "每日签到",
			checkinHint: "上游每日签到会发放积分。默认关闭：除非你打开，插件不会用你的账号发任何请求。",
			checkinAutoLabel: "自动签到",
			checkinAutoHint: "每天一次，覆盖每个可用账号。签到不会搁置账号，也不改动登录状态。",
			checkinRunNow: "立即签到",
			checkinRowNever: "尚未签到",
			checkinRowDay: "签到于 {day}",
			checkinRowFailed: "上次尝试失败：{reason}",
			checkinRowSkipped: "已跳过：{reason}"
		};
		//#endregion
		//#region src/client/index.tsx
		/** Stable browser-plugin name: the package name plus the `-client` half. */
		const name = "dsh-workbuddy-connect-functy-client";
		/**
		* Client services required by this browser half.
		*
		* DSH 0.1.2 removed `@deepseek-ai/dsh-client-runtime` (the package that used to
		* hold the browser `ClientContext` alias and the `slots` service), so the
		* services come from narrower packages: the `slots` registry lives in
		* `@deepseek-ai/dsh-client-ui-renderer` and `locale` in
		* `@deepseek-ai/dsh-client-locale`. None of the SEAT OWNERS is named here:
		* `sidebar.footer.action`, `main` and `settings.section` are declared by three
		* different packages, and the seam each host actually ships is discovered by
		* slot-declaration lifetime rather than by activation order — a static inject
		* would park this fiber on a package some profiles never mount.
		*/
		const inject = [
			"slots",
			"locale",
			"remote",
			"remote.session"
		];
		/** Prefix every guarded client contribution's degradation logs with this. */
		const CLIENT_CONTRIBUTION_FAILED = "[dsh-workbuddy-connect] client contribution failed to load (host provider unaffected):";
		/** Disposer handed back when a deferred registration degraded: nothing to undo. */
		const NOOP_DISPOSER = () => {};
		/**
		* The sidebar panel's id. It is the layout's `MainPanelId`: one string shared
		* by the `sidebar.footer.action` card and the `main` slot cell, so the card
		* selects this panel and nothing else.
		*/
		const PANEL_ID = "workbuddy-panel";
		/**
		* `ui-conversation`'s reserved `main` key, used only as the exit fallback for
		* a layout whose `selectPanel` predates the `null` "show the Conversation"
		* selection. Declared locally because `ui-conversation` is not a dependency of
		* this bundle and the key is a published contract of the layout.
		*/
		const CONVERSATION_PANEL_ID = "conversation";
		/** Inject the settings-page copy and resolve the translator bound to it. */
		function bindSettingsCopy(ctx, namespace) {
			return ctx.locale.bind(namespace);
		}
		/**
		* Inject one stylesheet once and return its disposer, for `ctx.effect` to own.
		*
		* Keyed by its own `data-plugin-css` id, so the injection is idempotent even if
		* a second surface asks for it later. The two ids must stay distinct from each
		* other: they key two separate style tags, and a shared id would make the
		* second injection a silent no-op that drops one stylesheet.
		*/
		function injectCss(id, css) {
			if (typeof document === "undefined") return NOOP_DISPOSER;
			if (document.querySelector(`style[data-plugin-css="${id}"]`) !== null) return NOOP_DISPOSER;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-workbuddy-connect";
			tag.dataset.pluginCss = id;
			tag.textContent = css;
			document.head.appendChild(tag);
			return () => {
				tag.remove();
			};
		}
		/**
		* Run ONE browser-side contribution, degrading its failure to a `console.error`
		* instead of throwing into the DSH loader. Returns the contribution's own value
		* on success, or `undefined` when it degraded — the deferred slot callbacks
		* below substitute `NOOP_DISPOSER` for that, because the slot runtime always
		* expects a disposer back.
		*
		* Every contribution is guarded at BOTH boundaries where it can throw:
		*
		* 1. the eager `ctx.slots.inject(...)` / `ctx.inject(...)` call itself, which
		*    runs synchronously inside `apply()` — e.g. a slot-API shape break such as
		*    the rc.6→rc.7 `id`→`key` rename;
		* 2. the deferred callback, which the slot runtime invokes later — when the
		*    owner commits the slot's declaration, or when the injected services
		*    arrive — long after `apply()` has returned, where no enclosing try/catch
		*    could still catch it.
		*
		* The pair is what makes the contributions independent: a failure in one
		* surface leaves every other registration intact. Guards are for THIS browser
		* half only; the host half reports its own errors through `ctx.logger`.
		*/
		function guardClientContribution(label, fn) {
			try {
				return fn();
			} catch (error) {
				console.error(`${CLIENT_CONTRIBUTION_FAILED} ${label}`, error);
				return;
			}
		}
		/**
		* Register the copy namespaces, the dashboard, and the conversation-side
		* surfaces, one guarded contribution at a time.
		*
		* The host provider keeps working throughout: the `workbuddy` model channel is
		* unaffected, and `dsh-workbuddy-connect status` reports host health via the
		* heartbeat file.
		*/
		function apply(ctx) {
			const namespace = "settings.workbuddy.functy";
			guardClientContribution("settings copy", () => {
				ctx.effect(() => ctx.locale.register(namespace, {
					zh,
					en
				}), "dsh-workbuddy-connect: settings copy");
			});
			const t = bindSettingsCopy(ctx, namespace);
			guardClientContribution("panel copy", () => {
				ctx.effect(() => ctx.locale.register(PANEL_LOCALE_NS, {
					zh: PANEL_COPY_ZH,
					en: PANEL_COPY_EN
				}), "dsh-workbuddy-connect: panel copy");
			});
			const panelStore = createWorkBuddyPanelStore();
			/**
			* The injected face both panel slots carry. `layout` is read reflectively AT
			* CLICK TIME, never captured at setup: ui-layout is not a dependency of this
			* bundle, so a static `inject` would park the whole client fiber.
			*/
			const panelFace = () => ({
				hooks: { workBuddyPanel: panelStore },
				refresh: () => {
					panelStore.refresh();
				},
				startAutoRefresh: () => panelStore.start(),
				open: () => {
					const layout = ctx.get("layout");
					if (typeof layout?.selectPanel === "function") layout.selectPanel(PANEL_ID);
				},
				close: () => {
					const layout = ctx.get("layout");
					if (typeof layout?.selectPanel !== "function") return;
					try {
						layout.selectPanel(null);
					} catch {
						try {
							layout.selectPanel(CONVERSATION_PANEL_ID);
						} catch (error) {
							console.error("[dsh-workbuddy-connect] could not close the dashboard:", error);
						}
					}
				}
			});
			guardClientContribution("styles", () => {
				ctx.effect(() => {
					const page = injectCss(PAGE_CSS_ID, PAGE_CSS);
					const panel = injectCss(PANEL_CSS_ID, PANEL_CSS);
					return () => {
						page();
						panel();
					};
				}, "dsh-workbuddy-connect: styles");
			});
			guardClientContribution("dashboard panel", () => {
				ctx.slots.inject("main", () => guardClientContribution("dashboard panel", () => ctx.slots.register({
					name: "main",
					key: "workbuddy-panel",
					locale: "panel.workbuddy.functy",
					inject: panelFace
				}, WorkBuddyPanel)) ?? NOOP_DISPOSER);
			});
			guardClientContribution("sidebar footer card", () => {
				ctx.inject(["layout"], (layoutCtx) => {
					if (typeof layoutCtx.get("layout")?.selectPanel !== "function") return;
					guardClientContribution("sidebar footer card", () => layoutCtx.slots.inject("sidebar.footer.action", () => guardClientContribution("sidebar footer card", () => layoutCtx.slots.register({
						name: "sidebar.footer.action",
						id: "workbuddy-panel",
						order: 1,
						locale: "panel.workbuddy.functy",
						inject: panelFace
					}, WorkBuddyFooterEntry)) ?? NOOP_DISPOSER));
				});
			});
			guardClientContribution("settings section", () => {
				ctx.slots.inject("settings.section", () => guardClientContribution("settings section", () => ctx.slots.register({
					name: "settings.section",
					id: "dsh-workbuddy",
					order: 40,
					label: () => t("navWorkBuddy"),
					locale: namespace,
					inject: () => ({
						t,
						context: ctx,
						refreshPanel: () => {
							panelStore.refresh();
						}
					})
				}, WorkBuddySettingsPage)) ?? NOOP_DISPOSER);
			});
			guardClientContribution("models provider card", () => {
				ctx.slots.inject("settings.models.provider-card", () => guardClientContribution("models provider card", () => ctx.slots.register({
					name: "settings.models.provider-card",
					key: "llm-workbuddy-functy",
					locale: namespace,
					inject: () => ({ t })
				}, WorkBuddyProviderCard)) ?? NOOP_DISPOSER);
			});
			guardClientContribution("composer credit badge", () => {
				ctx.inject(["modelDirectories"], (scope) => {
					guardClientContribution("composer credit badge", () => {
						scope.slots.inject("conversation.composer.dock", () => guardClientContribution("composer credit badge", () => scope.slots.register({
							name: "conversation.composer.dock",
							id: "workbuddy-credit-badge",
							order: 100,
							inject: (sessionId) => ({
								directory: scope.modelDirectories.directoryFor(sessionId).store,
								panel: panelStore,
								t: panelTranslator((key, params) => t(key, params))
							})
						}, WorkBuddyCreditBadge)) ?? NOOP_DISPOSER);
					});
				});
			});
			guardClientContribution("conversation probe control", () => {
				ctx.inject(["modelDirectories"], (scope) => {
					guardClientContribution("conversation probe control", () => {
						scope.slots.inject("conversation.input.right", () => guardClientContribution("conversation probe control", () => scope.slots.register({
							name: "conversation.input.right",
							id: "workbuddy-probe",
							order: 10,
							inject: (sessionId) => ({
								directory: scope.modelDirectories.directoryFor(sessionId).store,
								t
							})
						}, WorkBuddyProbeControl)) ?? NOOP_DISPOSER);
					});
				});
			});
		}
		//#endregion
		exports.CARD_VARIANTS = CARD_VARIANTS;
		exports.PANEL_ID = PANEL_ID;
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
