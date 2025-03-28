import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { User } from "../models/user.model.js";
import { deleteFromCloudinary, uploadOnCloudinary } from "../utils/cloudinary.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { Registration } from "../models/registration.model.js";
import { sendVerificationMail, sendForgotPasswordMail } from "../utils/sendEmail.js";
import jwt from 'jsonwebtoken';
import mongoose, { Mongoose } from "mongoose";
import { Video } from "../models/video.model.js";
import { Tweet } from "../models/tweet.model.js";
import { Subscription } from "../models/subscription.model.js";
import { Report } from "../models/report.model.js";
import { Playlist } from "../models/playlist.model.js";
import { Like } from "../models/like.model.js";
import { Comment } from "../models/comment.model.js";
import { encrypt, decrypt } from "../utils/crypto.js";
import { generateToken, verifyToken } from "../utils/jwt.js";

// pre-defined method for generating access and refresh tokens 
const generateAccessAndRefreshTokens = async (userId) => {
    try {
        const user = await User.findById(userId)

        // validating user
        if (!user) {
            throw new ApiError(404, "User not found");
        }

        const accessToken = user.generateAccessToken()
        const refreshToken = user.generateRefreshToken()

        user.refreshToken = refreshToken

        // updating the user in database
        await user.save({ validateBeforeSave: false })

        return { accessToken, refreshToken }

    } catch (error) {
        throw new ApiError(500, "Something went wrong while generating access and refresh tokens")
    }
}


// User methods -->

const emailRegistration = asyncHandler(async (req, res) => {
    const { email } = req.body

    if (!email || !email.trim()) {
        throw new ApiError(400, "Email is required.")
    }

    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailPattern.test(email)) {
        throw new ApiError(400, "Invalid email address format.");
    }

    const existedUser = await User.findOne({ email })

    if (existedUser) {
        throw new ApiError(409, "This email is already linked to an user.")
    }

    try {
        await Registration.findOneAndDelete({ email })
    } catch (error) {
        throw new ApiError(400, "Something went wrong while deleting the previous registration with the same email.")
    }

    const registration = await Registration.create({ email })

    if (!registration) {
        throw new ApiError(500, "Something went wrong while registering.")
    }

    const verificationOTP = Math.floor(Math.random() * 900000) + 100000;

    registration.verificationOTP = verificationOTP

    try {
        await registration.save({ validateBeforeSave: false });
    } catch (error) {
        throw new ApiError(500, "Error while saving registration: " + error.message);
    }

    try {
        await sendVerificationMail(email, verificationOTP);
    } catch (error) {
        throw new ApiError(500, "Error while sending verification email: " + error.message);
    }


    const token = generateToken(email);

    const cookiesOptions = {
        httpOnly: true,
        secure: true,
        maxAge: 20 * 60 * 1000,
    }

    return res
        .status(200)
        .cookie("emailToken", token, cookiesOptions)
        .json(
            new ApiResponse(
                200,
                { token },
                "OTP sent successfuly. Please verify your email."
            )
        )

})

const verifyEmail = asyncHandler(async (req, res) => {

    const { verificationOTP } = req.body;

    const incomingToken = req.cookies.emailToken || req.headers.authorization?.split(' ')[1]

    if (!incomingToken) {
        throw new ApiError(400, 'Token is required');
    }

    // Verify JWT and extract email
    const decoded = verifyToken(incomingToken);
    const email = decoded.data;

    if (!email) {
        throw new ApiError(400, "Something went wrong while decoding the email.")
    }

    const registration = await Registration.findOne({ email, verificationOTP });

    if (!registration) {
        throw new ApiError(400, "Invalid or expired OTP.");
    }

    try {
        await Registration.findOneAndDelete({ email })
    } catch (error) {
        throw new ApiError(500, "Something went wrong while deleting the old registration.")
    }

    const token = generateToken(email);

    const cookiesOptions = {
        httpOnly: true,
        secure: true,
        maxAge: 20 * 60 * 1000,
    }

    return res
        .status(200)
        .cookie("verifiedEmailToken", token, cookiesOptions)
        .clearCookie("emailToken")
        .json(
            new ApiResponse(
                200,
                {
                    email,
                    verified: true,
                    token
                },
                "Email verification successful."
            )
        )

})

const registerUser = asyncHandler(async (req, res) => {

    const incomingToken = req.cookies.verifiedEmailToken || req.headers.authorization?.split(' ')[1]

    if (!incomingToken) {
        throw new ApiError(400, 'Token is required');
    }

    const decoded = verifyToken(incomingToken);
    const email = decoded.data;

    if (!email) {
        throw new ApiError(400, "Something went wrong while decoding the email.")
    }

    // Getting user details

    const { fullName, username, password, bio = "Welcome to my profile! Excited to connect and share with everyone." } = req.body


    // Basic Validation

    if (
        [fullName, username, password].some((field) => field?.trim() === "")
    ) {
        throw new ApiError(400, "All fields are required!")
    }

    // username validation
    const usernamePattern = /^[a-zA-Z0-9-_]+$/;

    if (!usernamePattern.test(username)) {
        throw new ApiError(400, "Invalid username: only letters, numbers, hyphens, and underscores are allowed.")
    }

    // checking for existing user

    const existedUserWithEmail = await User.findOne({ email })

    if (existedUserWithEmail) {
        throw new ApiError(409, "User with email already exists")
    }

    const existedUserWithUsername = await User.findOne({ email })

    if (existedUserWithUsername) {
        throw new ApiError(409, "User with username already exists")
    }

    // create user object - create entry in db

    const user = await User.create({
        fullName,
        bio,
        avatar: "",
        coverImage: "",
        email,
        password,
        username: username.toLowerCase()
    })

    // checking if user is created and removing password and refreshToken

    const createdUser = await User.findById(user._id).select(
        "-password -refreshToken"
    )

    if (!createdUser) {
        throw new ApiError(500, "Something went wrong while registering the user!")
    }

    // returning response

    return res
        .status(201)
        .clearCookie("verifiedEmailToken")
        .json(
            new ApiResponse(200, createdUser, "User registered successfully!")
        )
})

const loginUser = asyncHandler(async (req, res) => {

    // 1. getting user details

    // Needs only one form field for username or email
    const { usernameOrEmail, password } = req.body

    // email or username is required
    if (!usernameOrEmail) {
        throw new ApiError(400, "email or username is required!")
    }
    if (!password) {
        throw new ApiError(400, "password is required!")
    }

    // 2. finding user by either email or username

    const user = await User.findOne({
        $or: [
            { email: usernameOrEmail },
            { username: usernameOrEmail }
        ]
    })

    // handling user not found
    if (!user) {
        throw new ApiError(404, "User not found, please check username or password!")
    }

    // 3. Checking is password correct or not

    const isPasswordValid = await user.isPasswordCorrect(password)

    if (!isPasswordValid) {
        throw new ApiError(404, "Password is incorrect!")
    }

    // 4. Generating Access and refersh tokens

    const { accessToken, refreshToken } = await generateAccessAndRefreshTokens(user._id)

    // fetching updated user from the database and removing unwanted attributes (such as password) before sending respond

    const loggedInUser = await User.findById(user._id).select("-password -refreshToken")

    // generating cookies

    const cookiesOptions = {
        httpOnly: true,
        secure: true
    }

    return res
        .status(200)
        .cookie("accessToken", accessToken, cookiesOptions)
        .cookie("refreshToken", refreshToken, cookiesOptions)
        .json(
            new ApiResponse(
                200,
                {
                    user: loggedInUser, // sending loggedin user data as user data
                    accessToken,
                    refreshToken
                },
                "User logged in successfully."
            )
        )

})

const logoutUser = asyncHandler(async (req, res) => {
    await User.findByIdAndUpdate(
        req.user._id,
        {
            $set: {
                refreshToken: undefined
            }
        },
        {
            new: true
        }
    )

    const cookiesOptions = {
        httpOnly: true,
        secure: true
    }

    return res
        .status(200)
        .clearCookie("accessToken", cookiesOptions)
        .clearCookie("refreshToken", cookiesOptions)
        .json(
            new ApiResponse(200, {}, "User logged out successfully!")
        )
})

const refreshAccessToken = asyncHandler(async (req, res) => {
    try {

        const incomingRefreshToken = req.body.refreshToken || req.cookies?.refreshToken

        if (!incomingRefreshToken) {
            throw new ApiError(401, "Unauthorized request!")
        }

        const decodedToken = jwt.verify(
            incomingRefreshToken,
            process.env.REFRESH_TOKEN_SECRET
        )
        const user = await User.findById(decodedToken?._id)

        if (!user) {
            throw new ApiError(401, "Invalid Refresh Token!")
        }

        if (incomingRefreshToken !== user?.refreshToken) {
            throw new ApiError(401, "Refresh Token is expired or used.")
        }

        const { accessToken, refreshToken } = await generateAccessAndRefreshTokens(user._id)
        const cookiesOptions = {
            httpOnly: true,
            secure: true
        }

        return res
            .status(200)
            .cookie("accessToken", accessToken, cookiesOptions)
            .cookie("refreshToken", refreshToken, cookiesOptions)
            .json(
                new ApiResponse(
                    200,
                    {
                        accessToken,
                        refreshToken
                    },
                    "Access token refreshed successfully"
                )
            )

    } catch (error) {
        throw new ApiError(401, error.message || "Invalid Refresh token1")
    }
})

const changeCurrentPassword = asyncHandler(async (req, res) => {
    const { oldPassword, newPassword, confirmNewPassword } = req.body

    if (newPassword !== confirmNewPassword) {
        throw new ApiError(400, "New password and confirmation password do not match.");
    }

    const user = await User.findById(req.user._id)

    const isPasswordValid = await user.isPasswordCorrect(oldPassword)

    if (!isPasswordValid) {
        throw new ApiError(400, "Invalid old password.")
    }

    user.password = newPassword
    await user.save({ validateBeforeSave: false })

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                {},
                "Password changed successfully."
            )
        )

})

const getCurrentUser = asyncHandler(async (req, res) => {
    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                req.user,
                "Current user fetched successfully."
            )
        )
})

const updateAccountDetails = asyncHandler(async (req, res) => {
    const { fullName, bio, username } = req.body

    // while updating files there should be a different end-point

    if (!String(fullName).trim() || !String(username).trim()) {
        throw new ApiError(400, "Full name and username are required.");
    }

    const user = await User.findById(req.user._id).select("-password -refreshToken")

    // changing the full name if modified

    if (fullName && fullName !== user.fullName) {
        user.fullName = fullName.trim()
    }

    if (bio && bio !== user.bio) {
        user.bio = bio.trim()
    }


    // Check if the username is already in use by another user
    if (username && user.username !== username) {

        const isUsernameExist = await User.findOne({ username })

        if (isUsernameExist) {
            throw new ApiError(
                400,
                "Sorry! This username is not available."
            )
        }

        user.username = username
    }

    await user.save({ validateBeforeSave: false })

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                user,
                "Account updated successfully."
            )
        )
})

const updateEmail = asyncHandler(async (req, res) => {
    const { newEmail, password } = req.body

    if (!String(newEmail).trim() || !String(password).trim()) {
        throw new ApiError(400, "Email and password is required.")
    }

    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailPattern.test(newEmail)) {
        throw new ApiError(400, "Invalid email address format.");
    }

    const existedUser = await User.findOne({ email: newEmail })

    if (existedUser) {
        throw new ApiError(409, "This email is already linked to an user.")
    }

    const user = await User.findById(req.user._id)

    const isPasswordValid = await user.isPasswordCorrect(password)

    if (!isPasswordValid) {
        throw new ApiError(400, "Incorrect password.")
    }

    if (newEmail === user.email) {
        throw new ApiError(400, "The new email cannot be the same as the current email.");
    }

    const updateEmailOTP = Math.floor(Math.random() * 900000) + 100000;

    user.updateEmailOTP = updateEmailOTP

    const otpExpiry = new Date(Date.now() + 20 * 60 * 1000);
    user.updateEmailOTPExpiry = otpExpiry

    try {
        await user.save({ validateBeforeSave: false });
    } catch (error) {
        throw new ApiError(500, "Error while saving user : " + error.message);
    }

    try {
        await sendVerificationMail(newEmail, updateEmailOTP);
    } catch (error) {
        throw new ApiError(500, "Error while sending mail verification OTP: " + error.message);
    }

    const updateEmailToken = generateToken(newEmail);

    const cookiesOptions = {
        httpOnly: true,
        secure: true,
        maxAge: 20 * 60 * 1000,
    }

    return res
        .status(200)
        .cookie("updateEmailToken", updateEmailToken, cookiesOptions)
        .json(
            new ApiResponse(
                200,
                { updateEmailToken },
                "Verification OTP sent successfully to new email."
            )
        )
})

const verifyUpdateEmailOTP = asyncHandler(async (req, res) => {

    const { updateEmailOTP } = req.body

    const updateEmailToken = req.cookies.updateEmailToken || req.headers.updateemailtoken
    if (!updateEmailToken) {
        throw new ApiError(400, 'Token is required');
    }
    const decoded = verifyToken(updateEmailToken);
    const newEmail = decoded.data;

    if (!newEmail) {
        throw new ApiError(400, "Something went wrong while decoding the email.")
    }

    const user = await User.findById(req.user._id)

    if (!user) {
        throw new ApiError(400, "Unauthorized request.")
    }

    if (user.updateEmailOTP !== updateEmailOTP) {
        throw new ApiError(400, "Invalid OTP.")
    }

    if (user.updateEmailOTPExpiry < Date.now()) {
        throw new ApiError(400, "OTP has expired.")
    }

    try {
        user.email = newEmail;
        user.updateEmailOTP = null;
        user.updateEmailOTPExpiry = null;
        await user.save({ validateBeforeSave: false });
    } catch (error) {
        user.updateEmailOTP = null;
        user.updateEmailOTPExpiry = null;
        await user.save({ validateBeforeSave: false });
        throw new ApiError(500, "Error while saving user : " + error.message);
    }

    try {
        await user.save({ validateBeforeSave: false });
    } catch (error) {
        throw new ApiError(500, "Error while saving user : " + error.message);
    }

    const cookiesOptions = {
        httpOnly: true,
        secure: true
    }

    return res
        .status(200)
        .clearCookie("updateEmailToken", cookiesOptions)
        .json(
            new ApiResponse(
                200,
                { user },
                "Email updated successfully."
            )
        )
})

const updateUserAvatar = asyncHandler(async (req, res) => {
    const avatarLocalPath = req.file?.path

    if (!avatarLocalPath) {
        throw new ApiError(400, "Avatar file is missing!")
    }

    const avatar = await uploadOnCloudinary(avatarLocalPath, "image")

    if (!avatar.url) {
        throw new ApiError(400, "Error while uploading an avatar.")
    }

    const user = await User.findById(req.user._id).select("-password -refreshToken")

    if (user.avatar.trim() !== '') {
        try {
            await deleteFromCloudinary(user.avatar);
        } catch (error) { }
    }
    user.avatar = avatar.url

    await user.save({ validateBeforeSave: false })

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                user,
                "Avatar updated successfully!"
            )
        )

})

const updateUserCoverImage = asyncHandler(async (req, res) => {
    const coverImageLocalPath = req.file?.path

    if (!coverImageLocalPath) {
        throw new ApiError(400, "Cover image file is missing!")
    }

    const coverImage = await uploadOnCloudinary(coverImageLocalPath, "image")

    if (!coverImage.url) {
        throw new ApiError(400, "Error while uploading a cover image.")
    }

    const user = await User.findById(req.user._id).select("-password -refreshToken")

    if (user.coverImage.trim() !== '') {
        try {
            await deleteFromCloudinary(user.coverImage);
        } catch (error) { }
    }

    user.coverImage = coverImage.url

    await user.save({ validateBeforeSave: false })

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                user,
                "Cover Image updated successfully!"
            )
        )

})

const removeUserAvatar = asyncHandler(async (req, res) => {

    const user = await User.findById(req.user._id).select("-password -refreshToken")

    if (user.avatar.trim() !== '') try {
        await deleteFromCloudinary(user.avatar);
    } catch (error) { }

    user.avatar = ''

    await user.save({ validateBeforeSave: false })

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                user,
                "Avatar removed successfully!"
            )
        )
})

const removeUserCoverImage = asyncHandler(async (req, res) => {

    const user = await User.findById(req.user._id).select("-password -refreshToken")

    if (user.coverImage.trim() !== '') {
        try {
            await deleteFromCloudinary(user.coverImage);
        } catch (error) { }
    }
    user.coverImage = ''

    await user.save({ validateBeforeSave: false })

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                user,
                "Cover image removed successfully!"
            )
        )
})

const getUserChannelProfile = asyncHandler(async (req, res) => {
    const { usernameOrId } = req.params

    if (!usernameOrId) {
        throw new ApiError(400, "username or channelId is required")
    }

    const userId = req.user?._id || null

    const isObjectId = mongoose.Types.ObjectId.isValid(usernameOrId);

    const matchConditions = [
        { username: usernameOrId.toLowerCase() }  // Match by username case-insensitively
    ];

    if (isObjectId) {
        matchConditions.push({ _id: new mongoose.Types.ObjectId(String(usernameOrId)) }); // Match by user ID if valid
    }

    const channel = await User.aggregate([
        {
            $match: {
                $or: matchConditions
            }
        },
        {
            $lookup: {
                from: "subscriptions",
                localField: "_id",
                foreignField: "channel",  // Fetch subscribers
                as: "subscribers",
            },
        },
        {
            $lookup: {
                from: "subscriptions",
                localField: "_id",
                foreignField: "subscriber",  // Fetch channels user is subscribed to
                as: "subscribedTo",
            },
        },
        {
            $addFields: {
                subscribersCount: { $size: "$subscribers" },  // Count of subscribers
                channelsSubscribedToCount: { $size: "$subscribedTo" },  // Count of subscriptions
                // Check if user is subscribed only if userId exists (authenticated)
                isSubscribed: userId
                    ? { $in: [userId, "$subscribers.subscriber"] }  // Checks subscription
                    : false,  // If no userId, isSubscribed is false
            },
        },
        {
            $project: {
                fullName: 1,
                username: 1,
                subscribersCount: 1,
                channelsSubscribedToCount: 1,
                isSubscribed: 1,
                avatar: 1,
                coverImage: 1,
                bio: 1,
            },
        },
    ]);

    if (!channel?.length) {
        throw new ApiError(404, "Channel does not exists!")
    }

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                channel[0],
                "Channel fetched successfully."
            )
        )

})


const getWatchHistory = asyncHandler(async (req, res) => {
    const user = await User.aggregate([
        {
            $match: {
                _id: new mongoose.Types.ObjectId(String(req.user._id))
            }
        },
        {
            $lookup: {
                from: "videos",
                localField: "watchHistory",
                foreignField: "_id",
                as: "watchHistory",
                pipeline: [
                    {
                        $lookup: {
                            from: "users",
                            localField: "owner",
                            foreignField: "_id",
                            as: "owner", // here overwriting the owner inside the video document
                            pipeline: [
                                {
                                    $project: {
                                        fullName: 1,
                                        username: 1,
                                        avatar: 1
                                    }
                                }
                            ]
                        },
                    },
                    {
                        $addFields: {
                            owner: {
                                $arrayElemAt: ["$owner", 0] // Get the first element directly
                            }
                        }
                    }
                ]
            }
        }
    ])

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                user[0].watchHistory,
                "Watch history fetched successfully."
            )
        )
})


const sendForgotPasswordOTP = asyncHandler(async (req, res) => {
    const { usernameOrEmail } = req.body

    if (!usernameOrEmail || !usernameOrEmail.trim()) {
        throw new ApiError(400, "Email or username is required.")
    }

    const user = await User.findOne({
        $or: [
            { email: usernameOrEmail },
            { username: usernameOrEmail }
        ]
    })

    if (!user) {
        throw new ApiError(404, "User not found.")
    }

    const forgotPasswordOTP = Math.floor(Math.random() * 900000) + 100000;
    user.forgotPasswordOTP = forgotPasswordOTP

    const otpExpiry = new Date(Date.now() + 15 * 60 * 1000);
    user.forgotPasswordOtpExpiry = otpExpiry

    try {
        await user.save({ validateBeforeSave: false });
    } catch (error) {
        throw new ApiError(500, "Error while saving user : " + error.message);
    }

    try {
        await sendForgotPasswordMail(user.email, forgotPasswordOTP, user.username);
    } catch (error) {
        throw new ApiError(500, "Error while sending forgot password email: " + error.message);
    }

    const token = generateToken(user.email);

    const cookiesOptions = {
        httpOnly: true,
        secure: true,
        maxAge: 20 * 60 * 1000,
    }

    return res
        .status(200)
        .cookie("forgotPassToken", token, cookiesOptions)
        .json(
            new ApiResponse(
                200,
                {
                    email: user.email,
                    token
                },
                "Forgot password OTP sent successfully."
            )
        )
})


const verifyForgotPasswordOTP = asyncHandler(async (req, res) => {

    const { forgotPasswordOTP } = req.body

    const incomingToken = req.cookies.forgotPassToken || req.headers.authorization?.split(' ')[1]; // Expecting 'Bearer <token>'

    if (!incomingToken) {
        throw new ApiError(400, 'Token is required');
    }
    // Verify JWT and extract email
    const decoded = verifyToken(incomingToken);
    const email = decoded.data;

    if (!email) {
        throw new ApiError(400, "Something went wrong while decoding the email.")
    }

    const user = await User.findOne({ email })

    if (!user) {
        throw new ApiError(400, "Session expired.")
    }

    if (user.forgotPasswordOTP !== forgotPasswordOTP) {
        throw new ApiError(400, "Invalid OTP.")
    }

    if (user.forgotPasswordOtpExpiry < Date.now()) {
        throw new ApiError(400, "OTP has expired.")
    }

    // reseting user properties after verification
    user.forgotPasswordOTP = null
    user.forgotPasswordOtpExpiry = null

    try {
        await user.save({ validateBeforeSave: false });
    } catch (error) {
        throw new ApiError(500, "Error while saving user: " + error.message);
    }

    const token = generateToken(user.email);

    const cookiesOptions = {
        httpOnly: true,
        secure: true,
        maxAge: 20 * 60 * 1000,
    }

    return res
        .status(200)
        .cookie("verifiedToken", token, cookiesOptions)
        .clearCookie("forgotPassToken")
        .json(
            new ApiResponse(
                200,
                { token },
                "Forgot password OTP verified successfully."
            )
        )
})


const forgotPassword = asyncHandler(async (req, res) => {

    const { newPassword } = req.body

    const incomingToken = req.cookies.verifiedToken || req.headers.authorization?.split(' ')[1]; // Expecting 'Bearer <token>'
    if (!incomingToken) {
        throw new ApiError(400, 'Token is required');
    }

    // Verify JWT and extract email
    const decoded = verifyToken(incomingToken);
    const email = decoded.data;

    if (!email) {
        throw new ApiError(400, "Something went wrong while decoding the email.")
    }
    if (!newPassword || !newPassword.trim()) {
        throw new ApiError(400, "Password is required.")
    }

    const user = await User.findOne({ email })

    if (!user) {
        throw new ApiError(400, "Forgot password token is invalid or expired.")
    }

    user.password = newPassword

    try {
        await user.save({ validateBeforeSave: false });
    } catch (error) {
        throw new ApiError(500, "Error while saving user: " + error.message);
    }

    const cookiesOptions = {
        httpOnly: true,
        secure: true
    }

    return res
        .status(200)
        .clearCookie("verifiedToken", cookiesOptions)
        .json(
            new ApiResponse(
                200,
                null,
                "Password updated successfully."
            )
        )

})


const deleteAccount = asyncHandler(async (req, res) => {
    const { password } = req.body

    if (!password || !password.trim()) {
        throw new ApiError(400, "Password is required.")
    }

    const user = await User.findById(req.user._id)

    const isPasswordValid = await user.isPasswordCorrect(password)

    if (!isPasswordValid) {
        throw new ApiError(400, "Incorrect password.")
    }

    // deleting other user related documents

    try {
        await Video.deleteMany({
            owner: req.user._id
        })

        await Tweet.deleteMany({
            owner: req.user._id
        })

        await Subscription.deleteMany({
            $or: [
                { subscriber: req.user._id },
                { channel: req.user._id },
            ]
        })

        await Report.deleteMany({
            reportBy: req.user._id
        })

        await Playlist.deleteMany({
            owner: req.user._id
        })

        await Like.deleteMany({
            likedBy: req.user._id
        })

        await Comment.deleteMany({
            owner: req.user._id
        })
    } catch (error) {
        throw new ApiError(500, "Something went wrong while deleting the user || Error: " + error)
    }

    // deleting the user at last

    const deletedUser = await User.findByIdAndDelete(req.user._id)

    if (!deletedUser) {
        throw new ApiError(500, "Something went wrong while deleting the user.")
    }

    if (user.avatar.trim() !== '') {
        try {
            await deleteFromCloudinary(user.avatar);
        } catch (error) { }
    }

    if (user.coverImage.trim() !== '') {
        try {
            await deleteFromCloudinary(user.coverImage)
        } catch (error) { }
    }

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                deletedUser,
                "Account deleted successfully."
            )
        )
})


const getAllUsers = asyncHandler(async (req, res) => {
    const { query, page = 1, limit = 30 } = req.query

    const userId = req.user?._id || null

    const primaryPipeline = [
        {
            $lookup: {
                from: "subscriptions",
                localField: "_id",
                foreignField: "channel",  // Fetch subscribers
                as: "subscribers",
            },
        },
        {
            $addFields: {
                isSubscribed: userId
                    ? { $in: [userId, "$subscribers.subscriber"] }  // Checks subscription
                    : false,  // If no userId, isSubscribed is false
            },
        },
        {
            $project: {
                fullName: 1,
                username: 1,
                isSubscribed: 1,
                avatar: 1,
                coverImage: 1,
                bio: 1,
            },
        },
        {
            $match: {
                ...(query && {
                    $or: [
                        { fullName: { $regex: query, $options: 'i' } },
                        { username: { $regex: query, $options: 'i' } },
                        { bio: { $regex: query, $options: 'i' } },
                    ]
                })
            }
        },
    ]

    const secondaryPipeline = [
        {
            $skip: (page - 1) * limit
        },

        {
            $limit: parseInt(limit)
        }
    ]

    const users = await User.aggregate([
        ...primaryPipeline,
        ...secondaryPipeline
    ])


    // Count total tweets matching the filters
    const totalUsers = await User.aggregate([
        ...primaryPipeline,
        { $count: "totalUsersCount" }
    ])

    if (!users || !totalUsers) {
        throw new ApiError(400, "Something went wrong while fetching users!")
    }

    const totalUsersCount = totalUsers.length > 0 ? totalUsers[0].totalUsersCount : 0;

    if (!users || !users.length) {
        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    {
                        users: [],
                        currentPage: parseInt(page),
                        totalPages: 0,
                        totalUsers: 0
                    },
                    "Sorry! No users found."
                )
            )
    }

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                {
                    users,
                    currentPage: parseInt(page),
                    totalPages: Math.ceil(totalUsersCount / limit),
                    totalUsers: totalUsersCount
                },
                "Users fetched successfully."
            )
        )

})


const getUserFollowers = asyncHandler(async (req, res) => {

    const { channelId } = req.params

    if (!channelId) {
        throw new ApiError(400, "channelId is missing")
    }

    let channelObjectId;

    try {
        channelObjectId = new mongoose.Types.ObjectId(String(channelId));
    } catch (error) {
        throw new ApiError(400, "Invalid channelId format");
    }

    const userId = req.user?._id || null

    const followers = await User.aggregate([
        {
            $lookup: {
                from: "subscriptions",
                localField: "_id",
                foreignField: "channel",
                as: "subscribers",
            },
        },
        {
            $lookup: {
                from: "subscriptions",
                localField: "_id",
                foreignField: "subscriber",
                as: "subscribedTo",
            },
        },
        {
            $addFields: {
                isSubscribed: userId
                    ? { $in: [userId, "$subscribers.subscriber"] }
                    : false,
            },
        },
        {
            $match: {
                subscribedTo: {
                    $elemMatch: { channel: channelObjectId }
                },
            },
        },
        {
            $project: {
                fullName: 1,
                username: 1,
                isSubscribed: 1,
                avatar: 1,
                coverImage: 1,
                bio: 1,
            },
        },

    ]);

    if (!followers || !followers.length) {
        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    {
                        followers: [],
                    },
                    "Sorry! No followers found."
                )
            )
    }

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                {
                    followers,
                },
                "Followers fetched successfully."
            )
        )
})


const getUserFollowings = asyncHandler(async (req, res) => {

    const { channelId } = req.params

    if (!channelId) {
        throw new ApiError(400, "channelId is missing")
    }

    let channelObjectId;

    try {
        channelObjectId = new mongoose.Types.ObjectId(String(channelId));
    } catch (error) {
        throw new ApiError(400, "Invalid channelId format");
    }

    const userId = req.user?._id || null

    const followings = await User.aggregate([
        {
            $lookup: {
                from: "subscriptions",
                localField: "_id",
                foreignField: "channel",
                as: "subscribers",
            },
        },
        {
            $addFields: {
                isSubscribed: userId
                    ? { $in: [userId, "$subscribers.subscriber"] }
                    : false,
            },
        },
        {
            $match: {
                subscribers: {
                    $elemMatch: { subscriber: channelObjectId }
                },
            },
        },
        {
            $project: {
                fullName: 1,
                username: 1,
                isSubscribed: 1,
                avatar: 1,
                coverImage: 1,
                bio: 1,
            },
        },

    ]);

    if (!followings || !followings.length) {
        return res
            .status(200)
            .json(
                new ApiResponse(
                    200,
                    {
                        followings: [],
                    },
                    "Sorry! No followings found."
                )
            )
    }

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                {
                    followings,
                },
                "Followings fetched successfully."
            )
        )
})


export {
    emailRegistration,
    verifyEmail,
    registerUser,
    loginUser,
    logoutUser,
    refreshAccessToken,
    changeCurrentPassword,
    getCurrentUser,
    updateAccountDetails,
    updateUserAvatar,
    updateUserCoverImage,
    removeUserAvatar,
    removeUserCoverImage,
    getUserChannelProfile,
    getWatchHistory,
    sendForgotPasswordOTP,
    verifyForgotPasswordOTP,
    forgotPassword,
    deleteAccount,
    getAllUsers,
    getUserFollowers,
    getUserFollowings,
    updateEmail,
    verifyUpdateEmailOTP
}