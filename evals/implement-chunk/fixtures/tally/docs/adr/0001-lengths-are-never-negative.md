# Lengths are never negative

Every caller sends a physical length: a cut, a run of cable, a parcel. A negative length is always a sign error in the caller's system, so the service answers a negative `value` with a 400, as it does a value that is not a number, and never converts it. Zero is a valid length. We considered converting signed values as displacements, which costs nothing in the arithmetic, and rejected it after two customers shipped orders whose negated lengths the service had converted without complaint.
