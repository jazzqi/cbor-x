"use strict"
let decoderModule = require('./decode')
let Decoder = decoderModule.Decoder
let mult10 = decoderModule.mult10
let C1Type = decoderModule.C1Type
const typedArrays = decoderModule.typedArrays
let encoder
try {
	encoder = new TextEncoder()
} catch (error) {}
let extensions, extensionClasses
const hasNodeBuffer = typeof Buffer !== 'undefined'
const ByteArrayAllocate = hasNodeBuffer ? Buffer.allocUnsafeSlow : Uint8Array
const ByteArray = hasNodeBuffer ? Buffer : Uint8Array
let target
let targetView
let position = 0
let safeEnd
const RECORD_SYMBOL = Symbol('record-id')
class Encoder extends Decoder {
	constructor(options) {
		super(options)
		this.offset = 0
		let typeBuffer
		let start
		let sharedStructures
		let hasSharedUpdate
		let structures
		let referenceMap
		let lastSharedStructuresLength = 0
		let encodeUtf8 = ByteArray.prototype.utf8Write ? function(string, position, maxBytes) {
			return target.utf8Write(string, position, maxBytes)
		} : (encoder && encoder.encodeInto) ?
			function(string, position) {
				return encoder.encodeInto(string, target.subarray(position)).written
			} : false

		let encoder = this
		let maxSharedStructures = 64
		let isSequential = options && options.sequential
		if (isSequential) {
			maxSharedStructures = 0
			this.structures = []
		}
		let recordIdsToRemove = []
		let transitionsCount = 0
		let serializationsSinceTransitionRebuild = 0
		if (this.structures && this.structures.length > maxSharedStructures) {
			throw new Error('Too many shared structures')
		}

		this.encode = function(value) {
			if (!target) {
				target = new ByteArrayAllocate(8192)
				targetView = new DataView(target.buffer, 0, 8192)
				position = 0
			}
			safeEnd = target.length - 10
			if (safeEnd - position < 0x800) {
				// don't start too close to the end, 
				target = new ByteArrayAllocate(target.length)
				targetView = new DataView(target.buffer, 0, target.length)
				safeEnd = target.length - 10
				position = 0
			}
			start = position
			referenceMap = encoder.structuredClone ? new Map() : null
			sharedStructures = encoder.structures
			if (sharedStructures) {
				if (sharedStructures.uninitialized)
					encoder.structures = sharedStructures = encoder.getStructures()
				let sharedStructuresLength = sharedStructures.length
				if (sharedStructuresLength >  maxSharedStructures && !isSequential)
					sharedStructuresLength = maxSharedStructures
				if (!sharedStructures.transitions) {
					// rebuild our structure transitions
					sharedStructures.transitions = Object.create(null)
					for (let i = 0; i < sharedStructuresLength; i++) {
						let keys = sharedStructures[i]
						if (!keys)
							continue
						let nextTransition, transition = sharedStructures.transitions
						for (let i =0, l = keys.length; i < l; i++) {
							let key = keys[i]
							nextTransition = transition[key]
							if (!nextTransition) {
								nextTransition = transition[key] = Object.create(null)
							}
							transition = nextTransition
						}
						transition[RECORD_SYMBOL] = i + 0x40
					}
					lastSharedStructuresLength = sharedStructures.length
				}
				if (!isSequential)
					sharedStructures.nextId = sharedStructuresLength + 0x40
			}
			if (hasSharedUpdate)
				hasSharedUpdate = false
			structures = sharedStructures || []
			try {
				encode(value)
				encoder.offset = position // update the offset so next serialization doesn't write over our buffer, but can continue writing to same buffer sequentially
				if (referenceMap && referenceMap.idsToInsert) {
					position += referenceMap.idsToInsert.length * 6
					if (position > safeEnd)
						makeRoom(position)
					encoder.offset = position
					let serialized = insertIds(target.subarray(start, position), referenceMap.idsToInsert)
					referenceMap = null
					return serialized
				}
				return target.subarray(start, position) // position can change if we call encode again in saveStructures, so we get the buffer now
			} finally {
				if (sharedStructures) {
					if (serializationsSinceTransitionRebuild < 10)
						serializationsSinceTransitionRebuild++
					if (transitionsCount > 10000) {
						// force a rebuild occasionally after a lot of transitions so it can get cleaned up
						sharedStructures.transitions = null
						serializationsSinceTransitionRebuild = 0
						transitionsCount = 0
						if (recordIdsToRemove.length > 0)
							recordIdsToRemove = []
					} else if (recordIdsToRemove.length > 0 && !isSequential) {
						for (let i = 0, l = recordIdsToRemove.length; i < l; i++) {
							recordIdsToRemove[i][RECORD_SYMBOL] = 0
						}
						recordIdsToRemove = []
					}
					if (hasSharedUpdate && encoder.saveStructures) {
						if (encoder.structures.length > maxSharedStructures) {
							encoder.structures = encoder.structures.slice(0, maxSharedStructures)
						}

						if (encoder.saveStructures(encoder.structures, lastSharedStructuresLength) === false) {
							// get updated structures and try again if the update failed
							encoder.structures = encoder.getStructures() || []
							return encoder.encode(value)
						}
						lastSharedStructuresLength = encoder.structures.length
					}
				}
			}
		}
		const encode = (value) => {
			if (position > safeEnd)
				target = makeRoom(position)

			var type = typeof value
			var length
			if (type === 'string') {
				let strLength = value.length
				let headerSize
				// first we estimate the header size, so we can write to the correct location
				if (strLength < 0x20) {
					headerSize = 1
				} else if (strLength < 0x100) {
					headerSize = 2
				} else if (strLength < 0x10000) {
					headerSize = 3
				} else {
					headerSize = 5
				}
				let maxBytes = strLength * 3
				if (position + maxBytes > safeEnd)
					target = makeRoom(position + maxBytes)

				if (strLength < 0x40 || !encodeUtf8) {
					let i, c1, c2, strPosition = position + headerSize
					for (i = 0; i < strLength; i++) {
						c1 = value.charCodeAt(i)
						if (c1 < 0x80) {
							target[strPosition++] = c1
						} else if (c1 < 0x800) {
							target[strPosition++] = c1 >> 6 | 0xc0
							target[strPosition++] = c1 & 0x3f | 0x80
						} else if (
							(c1 & 0xfc00) === 0xd800 &&
							((c2 = value.charCodeAt(i + 1)) & 0xfc00) === 0xdc00
						) {
							c1 = 0x10000 + ((c1 & 0x03ff) << 10) + (c2 & 0x03ff)
							i++
							target[strPosition++] = c1 >> 18 | 0xf0
							target[strPosition++] = c1 >> 12 & 0x3f | 0x80
							target[strPosition++] = c1 >> 6 & 0x3f | 0x80
							target[strPosition++] = c1 & 0x3f | 0x80
						} else {
							target[strPosition++] = c1 >> 12 | 0xe0
							target[strPosition++] = c1 >> 6 & 0x3f | 0x80
							target[strPosition++] = c1 & 0x3f | 0x80
						}
					}
					length = strPosition - position - headerSize
				} else {
					length = encodeUtf8(value, position + headerSize, maxBytes)
				}

				if (length < 0x18) {
					target[position++] = 0x60 | length
				} else if (length < 0x100) {
					if (headerSize < 2) {
						target.copyWithin(position + 2, position + 1, position + 1 + length)
					}
					target[position++] = 0x78
					target[position++] = length
				} else if (length < 0x10000) {
					if (headerSize < 3) {
						target.copyWithin(position + 3, position + 2, position + 2 + length)
					}
					target[position++] = 0x79
					target[position++] = length >> 8
					target[position++] = length & 0xff
				} else {
					if (headerSize < 5) {
						target.copyWithin(position + 5, position + 3, position + 3 + length)
					}
					target[position++] = 0x7a
					targetView.setUint32(position, length)
					position += 4
				}
				position += length
			} else if (type === 'number') {
				if (value >>> 0 === value) {// positive integer, 32-bit or less
					// positive uint
					if (value < 0x18) {
						target[position++] = value
					} else if (value < 0x100) {
						target[position++] = 0x18
						target[position++] = value
					} else if (value < 0x10000) {
						target[position++] = 0x19
						target[position++] = value >> 8
						target[position++] = value & 0xff
					} else {
						target[position++] = 0x1a
						targetView.setUint32(position, value)
						position += 4
					}
				} else if (value >> 0 === value) { // negative integer
					if (value >= -0x18) {
						target[position++] = 0x1f - value
					} else if (value >= -0x100) {
						target[position++] = 0x38
						target[position++] = ~value
					} else if (value >= -0x10000) {
						target[position++] = 0x39
						targetView.setUint16(position, ~value)
						position += 2
					} else {
						target[position++] = 0x3a
						targetView.setUint32(position, ~value)
						position += 4
					}
				} else {
					let useFloat32
					if ((useFloat32 = this.useFloat32) > 0 && value < 0x100000000 && value >= -0x80000000) {
						target[position++] = 0xfa
						targetView.setFloat32(position, value)
						let xShifted
						if (useFloat32 < 4 ||
							// this checks for  rounding of numbers that were encoded in 32-bit float to nearest significant decimal digit that could be preserved
								((xShifted = value * mult10[((target[position] & 0x7f) << 1) | (target[position + 1] >> 7)]) >> 0) === xShifted) {
							position += 4
							return
						} else
							position-- // move back into position for writing a double
					}
					target[position++] = 0xfb
					targetView.setFloat64(position, value)
					/*if (!target[position[4] && !target[position[5] && !target[position[6] && !target[position[7] && !(target[0] & 0x78) < ) {
						// something like this can be represented as a float with binary rounding
					}*/
					position += 8
				}
			} else if (type === 'object') {
				if (!value)
					target[position++] = 0xf6
				else {
					if (referenceMap) {
						let referee = referenceMap.get(value)
						if (referee) {
							if (!referee.id) {
								let idsToInsert = referenceMap.idsToInsert || (referenceMap.idsToInsert = [])
								referee.id = idsToInsert.push(referee)
							}
							target[position++] = 0xca // tag 10
							target[position++] = 0x1a // uint32
							targetView.setUint32(position, referee.id)
							position += 4
							return
						} else 
							referenceMap.set(value, { offset: position - start })
					}
					let constructor = value.constructor
					if (constructor === Object) {
						writeObject(value, true)
					} else if (constructor === Array) {
						length = value.length
						if (length < 0x18) {
							target[position++] = 0x80 | length
						} else if (length < 0x100) {
							target[position++] = 0x98
							target[position++] = length
						} else if (length < 0x10000) {
							target[position++] = 0x99
							target[position++] = length >> 8
							target[position++] = length & 0xff
						} else {
							target[position++] = 0x9a
							targetView.setUint32(position, length)
							position += 4
						}
						for (let i = 0; i < length; i++) {
							encode(value[i])
						}
					} else if (constructor === Map) {
						length = value.size
						if (length < 0x18) {
							target[position++] = 0xa0 | length
						} else if (length < 0x100) {
							target[position++] = 0xb8
							target[position++] = length
						} else if (length < 0x10000) {
							target[position++] = 0xb9
							target[position++] = length >> 8
							target[position++] = length & 0xff
						} else {
							target[position++] = 0xba
							targetView.setUint32(position, length)
							position += 4
						}
						for (let [ key, entryValue ] of value) {
							encode(key)
							encode(entryValue)
						}
					} else {	
						for (let i = 0, l = extensions.length; i < l; i++) {
							let extensionClass = extensionClasses[i]
							if (value instanceof extensionClass) {
								let extension = extensions[i]
								let currentTarget = target
								let currentTargetView = targetView
								let currentPosition = position
								target = null
								let result
								try {
									result = extension.encode.call(this, value, (size) => {
										target = currentTarget
										currentTarget = null
										position += size
										if (position > safeEnd)
											makeRoom(position)
										return {
											target, targetView, position: position - size
										}
									}, encode)
								} finally {
									// restore current target information (unless already restored)
									if (currentTarget) {
										target = currentTarget
										targetView = currentTargetView
										position = currentPosition
										safeEnd = target.length - 10
									}
								}
								if (result) {
									position = writeExtensionData(result, target, position, extension.type)
								}
								return
							}
						}
						// no extension found, write as object
						writeObject(value, false)
					}
				}
			} else if (type === 'boolean') {
				target[position++] = value ? 0xf5 : 0xf4
			} else if (type === 'bigint') {
				target[position++] = 0xfb
				/*if (value < 9223372036854776000 && value > -9223372036854776000) 
					targetView.setBigInt64(position, value)
				else*/
					targetView.setFloat64(position, value)
				position += 8
			} else if (type === 'undefined') {
				//target[position++] = 0xc1 // this is the "never-used" byte
				target[position++] = 0xf7
			} else {
				throw new Error('Unknown type ' + type)
			}
		}

		const writeObject = this.useRecords === false ? this.variableMapSize ? (object) => {
			let keys = Object.keys(object)
			let length = keys.length
			if (length < 0x18) {
				target[position++] = 0xa0 | length
			} else if (length < 0x100) {
				target[position++] = 0xb8
				target[position++] = length
			} else if (length < 0x10000) {
				target[position++] = 0xb9
				target[position++] = length >> 8
				target[position++] = length & 0xff
			} else {
				target[position++] = 0xba
				targetView.setUint32(position, length)
				position += 4
			}
			let key
			for (let i = 0; i < length; i++) {
				encode(key = keys[i])
				encode(object[key])
			}
		} :
		(object, safePrototype) => {
			target[position++] = 0xb9 // always use map 16, so we can preallocate and set the length afterwards
			let objectOffset = position - start
			position += 2
			let size = 0
			for (let key in object) {
				if (safePrototype || object.hasOwnProperty(key)) {
					encode(key)
					encode(object[key])
					size++
				}
			}
			target[objectOffset++ + start] = size >> 8
			target[objectOffset + start] = size & 0xff
		} :

	/*	sharedStructures ?  // For highly stable structures, using for-in can a little bit faster
		(object, safePrototype) => {
			let nextTransition, transition = structures.transitions || (structures.transitions = Object.create(null))
			let objectOffset = position++ - start
			let wroteKeys
			for (let key in object) {
				if (safePrototype || object.hasOwnProperty(key)) {
					nextTransition = transition[key]
					if (!nextTransition) {
						nextTransition = transition[key] = Object.create(null)
						nextTransition.__keys__ = (transition.__keys__ || []).concat([key])
						/*let keys = Object.keys(object)
						if 
						let size = 0
						let startBranch = transition.__keys__ ? transition.__keys__.length : 0
						for (let i = 0, l = keys.length; i++) {
							let key = keys[i]
							size += key.length << 2
							if (i >= startBranch) {
								nextTransition = nextTransition[key] = Object.create(null)
								nextTransition.__keys__ = keys.slice(0, i + 1)
							}
						}
						makeRoom(position + size)
						nextTransition = transition[key]
						target.copy(target, )
						objectOffset
					}
					transition = nextTransition
					encode(object[key])
				}
			}
			let id = transition.id
			if (!id) {
				id = transition.id = structures.push(transition.__keys__) + 63
				if (sharedStructures.onUpdate)
					sharedStructures.onUpdate(id, transition.__keys__)
			}
			target[objectOffset + start] = id
		}*/
		(object) => {
			let keys = Object.keys(object)
			let nextTransition, transition = structures.transitions || (structures.transitions = Object.create(null))
			let newTransitions = 0
			for (let i =0, l = keys.length; i < l; i++) {
				let key = keys[i]
				nextTransition = transition[key]
				if (!nextTransition) {
					nextTransition = transition[key] = Object.create(null)
					newTransitions++
				}
				transition = nextTransition
			}
			let recordId = transition[RECORD_SYMBOL]
			if (recordId) {
				target[position++] = 0xd8
				target[position++] = recordId
			} else {
				recordId = structures.nextId++
				if (!recordId) {
					recordId = 0x40
					structures.nextId = 0x41
				}
				if (recordId >= 0x100) {// cycle back around
					structures.nextId = (recordId = maxSharedStructures + 0x40) + 1
				}
				transition[RECORD_SYMBOL] = recordId
				structures[0x3f & recordId] = keys
				if (sharedStructures && sharedStructures.length <= maxSharedStructures) {
					target[position++] = 0xd8 // tag one byte
					target[position++] = recordId // tag number
					hasSharedUpdate = true
				} else {
					target[position++] = 0xc6 // tag 6
					target[position++] = recordId
					if (newTransitions)
						transitionsCount += serializationsSinceTransitionRebuild * newTransitions
					// record the removal of the id, we can maintain our shared structure
					if (recordIdsToRemove.length >= 0xc0 - maxSharedStructures)
						recordIdsToRemove.shift()[RECORD_SYMBOL] = 0 // we are cycling back through, and have to remove old ones
					recordIdsToRemove.push(transition)
					encode(keys)
				}
			}
			// now write the values
			for (let i =0, l = keys.length; i < l; i++)
				encode(object[keys[i]])
		}
		const makeRoom = (end) => {
			let newSize = ((Math.max((end - start) << 2, target.length - 1) >> 12) + 1) << 12
			let newBuffer = new ByteArrayAllocate(newSize)
			targetView = new DataView(newBuffer.buffer, 0, newSize)
			if (target.copy)
				target.copy(newBuffer, 0, start, end)
			else
				copyBinary(target, newBuffer, 0, start, end)
			position -= start
			start = 0
			safeEnd = newBuffer.length - 10
			return target = newBuffer
		}
	}
	useBuffer(buffer) {
		// this means we are finished using our own buffer and we can write over it safely
		target = buffer
		targetView = new DataView(target.buffer, target.byteOffset, target.byteLength)
		position = 0
	}
}
exports.Encoder = Encoder

function copyBinary(source, target, targetOffset, offset, endOffset) {
	while (offset < endOffset) {
		target[targetOffset++] = source[offset++]
	}
}

extensionClasses = [ Date, Set, Error, RegExp, ArrayBuffer, Object.getPrototypeOf(Uint8Array.prototype).constructor /*TypedArray*/, C1Type ]
extensions = [{
	encode(date, allocateForWrite) {
		let seconds = date.getTime() / 1000
		if ((this.useTimestamp32 || date.getMilliseconds() === 0) && seconds >= 0 && seconds < 0x100000000) {
			// Timestamp 32
			let { target, targetView, position} = allocateForWrite(6)
			target[position++] = 0xc1
			target[position++] = 0x1a
			targetView.setUint32(position, seconds)
		} else {
			// Timestamp float64
			let { target, targetView, position} = allocateForWrite(10)
			target[position++] = 0xc1
			target[position++] = 0xfb
			targetView.setFloat64(position, seconds)
		}
	}
}, {
	encode(set, allocateForWrite, encode) {
		let array = Array.from(set)
		if (this.structuredClone) {
			let { target, position} = allocateForWrite(1)
			target[position++] = 0xcb // tag 11
		}
		encode(array)
	}
}, {
	encode(error, allocateForWrite, encode) {
		if (this.structuredClone) {
			let { target, position} = allocateForWrite(1)
			target[position++] = 0xc8 // tag 8
		}
		encode([ error.name, error.message ])
	}
}, {
	encode(regex, allocateForWrite, encode) {
		if (this.structuredClone) {
			let { target, position} = allocateForWrite(1)
			target[position++] = 0xcd
		}
		encode([ regex.source, regex.flags ])
	}
}, {
	encode(arrayBuffer, allocateForWrite, encode) {
		if (this.structuredClone)
			writeExtBuffer(arrayBuffer, 0x10, allocateForWrite, encode)
		else
			writeBuffer(hasNodeBuffer ? Buffer.from(arrayBuffer) : new Uint8Array(arrayBuffer), allocateForWrite)
	}
}, {
	encode(typedArray, allocateForWrite, encode) {
		let constructor = typedArray.constructor
		if (constructor !== ByteArray && this.structuredClone)
			writeExtBuffer(typedArray, typedArrays.indexOf(constructor.name), allocateForWrite, encode)
		else
			writeBuffer(typedArray, allocateForWrite)
	}
}, {
	encode(c1, allocateForWrite) { // specific 0xC1 object
		let { target, position} = allocateForWrite(1)
		target[position] = 0xc1
	}
}]

function writeExtBuffer(typedArray, type, allocateForWrite, encode) {
	let length = typedArray.byteLength
	let offset = typedArray.byteOffset || 0
	let buffer = typedArray.buffer || typedArray
	let { target, position, targetView } = allocateForWrite(1)
	target[position++] = 0xcc
	encode([type, hasNodeBuffer ? Buffer.from(buffer, offset, length) :
		new Uint8Array(buffer, offset, length)])
}
function writeBuffer(buffer, allocateForWrite) {
	let length = buffer.byteLength
	var target, position
	if (length < 0x100) {
		var { target, position } = allocateForWrite(length + 2)
		target[position++] = 0x58
		target[position++] = length
	} else if (length < 0x10000) {
		var { target, position } = allocateForWrite(length + 3)
		target[position++] = 0x59
		target[position++] = length >> 8
		target[position++] = length & 0xff
	} else {
		var { target, position, targetView } = allocateForWrite(length + 5)
		target[position++] = 0x5a
		targetView.setUint32(position, length)
		position += 4
	}
	if (buffer.copy)
		buffer.copy(target, position)
	else
		copyBinary(buffer, target, position, 0, length)
}

function writeExtensionData(result, target, position, type) {
	let length = result.length
	switch (length) {
		case 1:
			target[position++] = 0xd4
			break
		case 2:
			target[position++] = 0xd5
			break
		case 4:
			target[position++] = 0xd6
			break
		case 8:
			target[position++] = 0xd7
			break
		case 16:
			target[position++] = 0xd8
			break
		default:
			if (length < 0x100) {
				target[position++] = 0xc7
				target[position++] = length
			} else if (length < 0x10000) {
				target[position++] = 0xc8
				target[position++] = length << 8
				target[position++] = length & 0xff
			} else {
				target[position++] = 0xc9
				target[position++] = length << 24
				target[position++] = (length << 16) & 0xff
				target[position++] = (length << 8) & 0xff
				target[position++] = length & 0xff
			}
	}
	target[position++] = type
	if (result.copy)
		result.copy(target, position)
	else
		copyBinary(result, target, position, 0, length)
	position += length
	return position
}

function insertIds(serialized, idsToInsert) {
	// insert the ids that need to be referenced for structured clones
	let nextId
	let distanceToMove = idsToInsert.length * 6
	let lastEnd = serialized.length - distanceToMove
	idsToInsert.sort((a, b) => a.offset > b.offset ? 1 : -1)
	while (nextId = idsToInsert.pop()) {
		let offset = nextId.offset
		let id = nextId.id
		serialized.copyWithin(offset + distanceToMove, offset, lastEnd)
		distanceToMove -= 6
		let position = offset + distanceToMove
		serialized[position++] = 0xc9 // tag 9
		serialized[position++] = 0x1a // uint32
		serialized[position++] = id << 24
		serialized[position++] = (id << 16) & 0xff
		serialized[position++] = (id << 8) & 0xff
		serialized[position++] = id & 0xff
		lastEnd = offset
	}
	return serialized
}

exports.addExtension = function(extension) {
	if (extension.Class) {
		if (!extension.encode)
			throw new Error('Extension has no encode function')
		extensionClasses.unshift(extension.Class)
		extensions.unshift(extension)
	}
	decoderModule.addExtension(extension)
}
