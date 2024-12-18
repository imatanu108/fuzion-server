import { Router } from "express";
import { upload } from "../middlewares/multer.middleware.js";
import { verifyJWT } from "../middlewares/auth.middleware.js";
import { optionalAuth } from "../middlewares/optionalAuth.middleware.js";
import {
    publishAVideo,
    updateVideo,
    deleteVideo,
    togglePublishStatus,
    getVideoById,
    getAllVideos,
    getVideosByChannel
} from "../controllers/video.controller.js";

const router = Router()

// router.use(verifyJWT); // Apply verifyJWT middleware to all routes in this file

router
    .route("/")
    .post(
        verifyJWT,
        upload.fields([
            {
                name: "videoFile",
                maxCount: 1,
            },
            {
                name: "thumbnail",
                maxCount: 1,
            },

        ]),
        publishAVideo
    );

router
    .route("/search/all")
    .get(getAllVideos)

router
    .route("/:videoId")
    .get(optionalAuth, getVideoById)
    .delete(verifyJWT, deleteVideo)
    .patch(verifyJWT, upload.fields([
        {
            name: "thumbnail",
            maxCount: 1,
        },
    ]), updateVideo);

router.route("/toggle/publish/:videoId").patch(verifyJWT, togglePublishStatus);

router.route("/user/:usernameOrId").get(optionalAuth, getVideosByChannel)


export default router